import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { kvSet } from '../../db/kv.js';
import { tokens, type NewToken, type Token } from '../../db/schema.js';
import { cached, invalidate } from '../../lib/cache.js';
import { chain, NATIVE_TOKEN, normAddress } from '../../lib/chain.js';
import { fetchJson } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { publicClient } from '../../lib/viem.js';

const erc20DecimalsAbi = [{
  type: 'function',
  name: 'decimals',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint8' }],
}] as const;

type RhAsset = {
  id?: unknown;
  tokenSymbol?: unknown;
  tokenName?: unknown;
  deployments?: unknown;
  currentMultiplier?: unknown;
  status?: unknown;
  logoUrl?: unknown;
  tokenDecimals?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decimalString(value: unknown, fallback = '1'): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) return fallback;
  return text;
}

function validDecimals(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : null;
}

function deploymentForChain(deployments: unknown): { address: string } | null {
  if (!Array.isArray(deployments)) return null;
  for (const deployment of deployments) {
    if (!isRecord(deployment) || Number(deployment.chainId) !== chain.id) continue;
    if (typeof deployment.contractAddress !== 'string' || !/^0x[0-9a-f]{40}$/i.test(deployment.contractAddress)) continue;
    return { address: deployment.contractAddress.toLowerCase() };
  }
  return null;
}

async function invalidateTokenList(): Promise<void> {
  await invalidate('tokens:active');
}

export async function syncWellKnown(): Promise<void> {
  const rows: NewToken[] = [
    {
      address: NATIVE_TOKEN,
      chainId: chain.id,
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      kind: 'native',
      logoUrl: '/assets/brands/ethereum.svg',
      multiplier: '1',
      rhAssetId: null,
      active: true,
      sort: 0,
    },
    ...chain.wellKnownTokens.map((token) => ({
      address: token.address.toLowerCase(),
      chainId: chain.id,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      kind: token.kind,
      logoUrl: token.logoUrl ?? (token.symbol === 'WETH' ? '/assets/brands/ethereum.svg' : null),
      multiplier: '1',
      rhAssetId: null,
      active: true,
      sort: token.sort,
    })),
  ];

  await db.insert(tokens).values(rows).onConflictDoUpdate({
    target: tokens.address,
    set: {
      chainId: sql`excluded.chain_id`,
      symbol: sql`excluded.symbol`,
      name: sql`excluded.name`,
      decimals: sql`excluded.decimals`,
      kind: sql`excluded.kind`,
      logoUrl: sql`excluded.logo_url`,
      multiplier: sql`excluded.multiplier`,
      rhAssetId: sql`excluded.rh_asset_id`,
      active: sql`excluded.active`,
      sort: sql`excluded.sort`,
      updatedAt: sql`now()`,
    },
  });
  await invalidateTokenList();
}

export async function ensureTokensSeeded(): Promise<void> {
  await syncWellKnown();
}

export async function syncStockTokens(): Promise<void> {
  if (chain.isTestnet) {
    logger.info({ chainId: chain.id }, 'stock token sync skipped on testnet');
    return;
  }

  const response = await fetchJson<{ assets?: unknown }>('https://api.robinhood.com/rhj/assets');
  if (!Array.isArray(response.assets)) {
    throw new TypeError('Robinhood assets response has no assets array.');
  }

  const selected: Array<{ asset: RhAsset; address: string }> = [];
  const seen = new Set<string>();
  for (const value of response.assets) {
    if (!isRecord(value)) continue;
    const asset = value as RhAsset;
    const deployment = deploymentForChain(asset.deployments);
    if (!deployment || typeof asset.tokenSymbol !== 'string' || typeof asset.tokenName !== 'string') continue;
    if (!/^[\w.-]{1,32}$/.test(asset.tokenSymbol) || asset.tokenName.length === 0) continue;
    if (seen.has(deployment.address)) continue;
    selected.push({ asset, address: deployment.address });
    seen.add(deployment.address);
  }

  const decimalsMissing = selected.filter(({ asset }) => validDecimals(asset.tokenDecimals) === null);
  const decimalsByAddress = new Map<string, number>();
  if (decimalsMissing.length > 0) {
    const uniqueMissing = [...new Map(decimalsMissing.map((item) => [item.address, item])).values()];
    try {
      const results = await publicClient.multicall({
        contracts: uniqueMissing.map(({ address }) => ({
          address: address as `0x${string}`,
          abi: erc20DecimalsAbi,
          functionName: 'decimals' as const,
        })),
        allowFailure: true,
      });
      results.forEach((result, index) => {
        if (result.status === 'success') decimalsByAddress.set(uniqueMissing[index].address, Number(result.result));
      });
    } catch (error) {
      logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'stock token decimals lookup failed; defaulting missing decimals to 18');
    }
  }

  const rows: NewToken[] = selected.map(({ asset, address }) => {
    const tokenDecimals = validDecimals(asset.tokenDecimals) ?? decimalsByAddress.get(address) ?? 18;
    const rhAssetId = typeof asset.id === 'string' || typeof asset.id === 'number' ? String(asset.id) : null;
    const logoUrl = typeof asset.logoUrl === 'string' && asset.logoUrl.length > 0 ? asset.logoUrl : null;
    return {
      address,
      chainId: chain.id,
      symbol: asset.tokenSymbol as string,
      name: asset.tokenName as string,
      decimals: tokenDecimals,
      kind: 'stock',
      logoUrl,
      multiplier: decimalString(asset.currentMultiplier),
      rhAssetId,
      active: asset.status === 'ASSET_STATUS_ACTIVE',
      sort: 1000,
    };
  });

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx.insert(tokens).values(rows).onConflictDoUpdate({
        target: tokens.address,
        set: {
          chainId: sql`excluded.chain_id`,
          symbol: sql`excluded.symbol`,
          name: sql`excluded.name`,
          decimals: sql`excluded.decimals`,
          kind: sql`excluded.kind`,
          logoUrl: sql`excluded.logo_url`,
          multiplier: sql`excluded.multiplier`,
          rhAssetId: sql`excluded.rh_asset_id`,
          active: sql`excluded.active`,
          sort: sql`excluded.sort`,
          updatedAt: sql`now()`,
        },
      });
    }

    const stale = await tx.select({ address: tokens.address }).from(tokens).where(and(
      eq(tokens.chainId, chain.id),
      eq(tokens.kind, 'stock'),
      ...(seen.size > 0 ? [notInArray(tokens.address, [...seen])] : []),
    ));
    const staleAddresses = stale.map((row) => row.address);
    if (staleAddresses.length > 0) {
      await tx.update(tokens).set({ active: false, updatedAt: new Date() }).where(inArray(tokens.address, staleAddresses));
    }
    await kvSet('tokens:lastSync', { at: new Date().toISOString(), count: rows.length }, tx);
  });

  await invalidateTokenList();
  logger.info({ count: rows.length, chainId: chain.id }, 'stock token registry synced');
}

export async function getActiveTokens(): Promise<Token[]> {
  return cached('tokens:active', 60, () => db.select().from(tokens)
    .where(and(eq(tokens.chainId, chain.id), eq(tokens.active, true)))
    .orderBy(asc(tokens.sort), asc(tokens.symbol)));
}

export async function getToken(address: string): Promise<Token | null> {
  const normalized = normAddress(address);
  return (await getActiveTokens()).find((token) => token.address === normalized) ?? null;
}
