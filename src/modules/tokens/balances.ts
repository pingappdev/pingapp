import { erc20Abi, type Address } from 'viem';
import type { Token } from '../../db/schema.js';
import { chain } from '../../lib/chain.js';
import { logger } from '../../lib/logger.js';
import { formatAmount, usdValue } from '../../lib/money.js';
import { publicClient } from '../../lib/viem.js';
import { getMinAmountRaw } from './minimum.js';
import { getPrices } from './prices.js';
import { getActiveTokens } from './registry.js';
import { toTokenDto, type TokenDto } from './routes.js';

export type AssetDto = {
  token: TokenDto;
  balanceRaw: string;
  balance: string;
  valueUsd: string | null;
};

export type BalancesDto = {
  totalUsd: string | null;
  items: AssetDto[];
};

const MULTICALL_CHUNK_SIZE = 150;
const FALLBACK_CHUNK_SIZE = 10;

function logBalanceFailure(token: Token, error?: unknown): void {
  logger.debug({
    symbol: token.symbol,
    ...(error instanceof Error ? { errorType: error.name } : {}),
  }, 'token balance lookup failed; using zero');
}

async function readMulticallBalances(
  tokens: Token[],
  address: Address,
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();

  for (let offset = 0; offset < tokens.length; offset += MULTICALL_CHUNK_SIZE) {
    const chunk = tokens.slice(offset, offset + MULTICALL_CHUNK_SIZE);
    const results = await publicClient.multicall({
      contracts: chunk.map((token) => ({
        address: token.address as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      })),
      allowFailure: true,
      batchSize: 1024 * 32,
    });

    chunk.forEach((token, index) => {
      const result = results[index];
      if (result?.status === 'success' && typeof result.result === 'bigint') {
        balances.set(token.address.toLowerCase(), result.result);
      } else {
        logBalanceFailure(token, result?.status === 'failure' ? result.error : undefined);
        balances.set(token.address.toLowerCase(), 0n);
      }
    });
  }

  return balances;
}

async function readFallbackBalances(
  tokens: Token[],
  address: Address,
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();

  for (let offset = 0; offset < tokens.length; offset += FALLBACK_CHUNK_SIZE) {
    const chunk = tokens.slice(offset, offset + FALLBACK_CHUNK_SIZE);
    const results = await Promise.all(chunk.map(async (token) => {
      try {
        const balance = await publicClient.readContract({
          address: token.address as Address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        });
        return { token, balance };
      } catch (error) {
        logBalanceFailure(token, error);
        return { token, balance: 0n };
      }
    }));

    for (const { token, balance } of results) {
      balances.set(token.address.toLowerCase(), balance);
    }
  }

  return balances;
}

function usdCents(value: string): bigint {
  const [whole, fraction = '00'] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

function formatUsdCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function sumUsdValues(items: AssetDto[]): string | null {
  const values = items.flatMap((item) => item.valueUsd === null ? [] : [item.valueUsd]);
  if (values.length === 0) return null;
  return formatUsdCents(values.reduce((total, value) => total + usdCents(value), 0n));
}

export async function getBalances(address: Address): Promise<BalancesDto> {
  const tokens = await getActiveTokens();
  const nativeTokens = tokens.filter((token) => token.kind === 'native');
  const erc20Tokens = tokens.filter((token) => token.kind !== 'native');
  const firstStable = tokens.find((token) => token.kind === 'stable');

  const [ethBalance, erc20Balances, prices] = await Promise.all([
    publicClient.getBalance({ address }),
    chain.multicall3 === null
      ? readFallbackBalances(erc20Tokens, address)
      : readMulticallBalances(erc20Tokens, address),
    getPrices(),
  ]);

  const rows = tokens.filter((token) => {
    if (token.kind === 'native' || token === firstStable) return true;
    return (erc20Balances.get(token.address.toLowerCase()) ?? 0n) > 0n;
  });

  const sortedItems = await Promise.all(rows.map(async (token) => {
    const balanceRaw = nativeTokens.includes(token)
      ? ethBalance
      : erc20Balances.get(token.address.toLowerCase()) ?? 0n;
    const price = prices.get(token.address.toLowerCase()) ?? null;
    const minRaw = await getMinAmountRaw(token, price);
    return {
      sort: token.sort,
      asset: {
        token: toTokenDto(token, price, minRaw),
        balanceRaw: balanceRaw.toString(),
        balance: formatAmount(balanceRaw, token.decimals),
        valueUsd: usdValue(balanceRaw, token.decimals, price),
      } satisfies AssetDto,
    };
  }));

  sortedItems.sort((left, right) => {
    if (left.asset.valueUsd === null && right.asset.valueUsd !== null) return 1;
    if (left.asset.valueUsd !== null && right.asset.valueUsd === null) return -1;
    if (left.asset.valueUsd !== null && right.asset.valueUsd !== null) {
      const leftCents = usdCents(left.asset.valueUsd);
      const rightCents = usdCents(right.asset.valueUsd);
      if (leftCents !== rightCents) return leftCents > rightCents ? -1 : 1;
    }
    return left.sort - right.sort || left.asset.token.symbol.localeCompare(right.asset.token.symbol);
  });

  const items = sortedItems.map(({ asset }) => asset);
  return { totalUsd: sumUsdValues(items), items };
}
