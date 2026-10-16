import { isAddress, getAddress } from 'viem';
import { z } from 'zod';
import type { RouterWatchConfig } from './watcher.js';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const nonnegativeInt = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);
const envSchema = z.object({
  ROUTER_WATCH_DATABASE_URL: z.string().url(),
  ROUTER_WATCH_RPC_URL: z.string().url(),
  ROUTER_WATCH_CHAIN_ID: z.coerce.number().int().positive(),
  ROUTER_WATCH_ROUTER_ADDRESS: z.string().refine(isAddress, 'must be an EVM address'),
  ROUTER_WATCH_START_BLOCK: z.coerce.number().int().nonnegative(),
  ROUTER_WATCH_CONFIRMATIONS: nonnegativeInt(2),
  ROUTER_WATCH_CHUNK_BLOCKS: positiveInt(1000).refine((value) => value <= 10_000),
  ROUTER_WATCH_SIGNING_TIME_SKEW_SECONDS: nonnegativeInt(60).refine((value) => value <= 600),
  ROUTER_WATCH_POLL_MS: positiveInt(15_000).refine((value) => value >= 1000),
  ROUTER_WATCH_JOURNAL_PATH: z.string().min(1),
  ROUTER_WATCH_INDEXER_LAG_BLOCKS: nonnegativeInt(100),
  ROUTER_WATCH_SIGNING_PER_HOUR_LIMIT: nonnegativeInt(100),
  ROUTER_WATCH_STUCK_CLAIM_MINUTES: positiveInt(10),
  ROUTER_WATCH_SMS_DEFERRED_LIMIT: nonnegativeInt(5),
  ROUTER_WATCH_SMS_UNKNOWN_LIMIT: nonnegativeInt(1),
  ROUTER_WATCH_RELAYER_ADDRESS: z.string().optional().default(''),
  ROUTER_WATCH_RELAYER_MIN_ETH: z.string().regex(/^\d+(?:\.\d+)?$/).default('0.01'),
  ROUTER_WATCH_DELIVERY_URL: z.union([z.literal(''), z.string().url()]).optional().default(''),
  ROUTER_WATCH_DELIVERY_TOKEN: z.string().optional().default(''),
});

export type RouterWatchRuntimeConfig = RouterWatchConfig & {
  databaseUrl: string; rpcUrl: string; journalPath: string; pollMs: number;
  deliveryUrl?: URL; deliveryToken?: string;
};

export function parseRouterWatchConfig(env: NodeJS.ProcessEnv = process.env): RouterWatchRuntimeConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const variables = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'watch configuration')))];
    throw new Error(`Invalid router watcher configuration: ${variables.join(', ')}.`);
  }
  const value = parsed.data;
  const databaseUrl = new URL(value.ROUTER_WATCH_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new Error('ROUTER_WATCH_DATABASE_URL must use PostgreSQL.');
  const rpcUrl = new URL(value.ROUTER_WATCH_RPC_URL);
  if (!['http:', 'https:'].includes(rpcUrl.protocol)) throw new Error('ROUTER_WATCH_RPC_URL must use HTTP or HTTPS.');
  const deliveryUrl = value.ROUTER_WATCH_DELIVERY_URL ? new URL(value.ROUTER_WATCH_DELIVERY_URL) : undefined;
  if (deliveryUrl && !['http:', 'https:'].includes(deliveryUrl.protocol)) {
    throw new Error('ROUTER_WATCH_DELIVERY_URL must use HTTP or HTTPS.');
  }
  const relayerAddress = value.ROUTER_WATCH_RELAYER_ADDRESS
    ? getAddress(value.ROUTER_WATCH_RELAYER_ADDRESS) : undefined;
  if (value.ROUTER_WATCH_RELAYER_ADDRESS && !isAddress(value.ROUTER_WATCH_RELAYER_ADDRESS)) {
    throw new Error('ROUTER_WATCH_RELAYER_ADDRESS must be an EVM address.');
  }
  const [whole, fraction = ''] = value.ROUTER_WATCH_RELAYER_MIN_ETH.split('.');
  const relayerMinBalanceWei = BigInt(whole) * 10n ** 18n + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
  return {
    databaseUrl: value.ROUTER_WATCH_DATABASE_URL,
    rpcUrl: value.ROUTER_WATCH_RPC_URL,
    journalPath: value.ROUTER_WATCH_JOURNAL_PATH,
    pollMs: value.ROUTER_WATCH_POLL_MS,
    chainId: value.ROUTER_WATCH_CHAIN_ID,
    routerAddress: getAddress(value.ROUTER_WATCH_ROUTER_ADDRESS),
    startBlock: BigInt(value.ROUTER_WATCH_START_BLOCK),
    confirmations: BigInt(value.ROUTER_WATCH_CONFIRMATIONS),
    chunkBlocks: BigInt(value.ROUTER_WATCH_CHUNK_BLOCKS),
    signingTimeSkewSeconds: value.ROUTER_WATCH_SIGNING_TIME_SKEW_SECONDS,
    indexerLagBlocks: BigInt(value.ROUTER_WATCH_INDEXER_LAG_BLOCKS),
    signingPerHourLimit: value.ROUTER_WATCH_SIGNING_PER_HOUR_LIMIT,
    stuckClaimMinutes: value.ROUTER_WATCH_STUCK_CLAIM_MINUTES,
    smsBudgetDeferredLimit: value.ROUTER_WATCH_SMS_DEFERRED_LIMIT,
    smsProviderUnknownLimit: value.ROUTER_WATCH_SMS_UNKNOWN_LIMIT,
    ...(relayerAddress ? { relayerAddress } : {}),
    relayerMinBalanceWei,
    ...(deliveryUrl ? { deliveryUrl } : {}),
    ...(value.ROUTER_WATCH_DELIVERY_TOKEN ? { deliveryToken: value.ROUTER_WATCH_DELIVERY_TOKEN } : {}),
  };
}
