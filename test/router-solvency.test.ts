import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as { id: string }[],
  escrows: new Map<string, readonly [string, bigint, string, bigint, bigint]>(),
  native: 0n,
  tokens: new Map<string, bigint>(),
  feesAccrued: 0n,
  totalOwed: 0n,
  blocks: [] as (bigint | undefined)[],
  kv: new Map<string, unknown>(),
  fail: false,
}));

const { ROUTER, NATIVE, USDG, SENDER, ZERO } = vi.hoisted(() => ({
  ROUTER: '0x0000000000000000000000000000000000000003',
  NATIVE: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  USDG: '0x00000000000000000000000000000000000000aa',
  SENDER: '0x0000000000000000000000000000000000000001',
  ZERO: '0x0000000000000000000000000000000000000000',
}));

vi.mock('../src/config.js', () => ({ config: { ROUTER_ENABLED: true, ROUTER_ADDRESS: ROUTER } }));
vi.mock('../src/db/schema.js', () => ({ escrows: { id: 'id', status: 'status' } }));
vi.mock('drizzle-orm', () => ({ inArray: (...values: unknown[]) => values }));
vi.mock('../src/db/client.js', () => ({ db: { select: () => ({ from: () => ({ where: async () => state.rows }) }) } }));
vi.mock('../src/db/kv.js', () => ({
  kvGet: vi.fn(async (key: string) => state.kv.get(key)),
  kvSet: vi.fn(async (key: string, value: unknown) => { state.kv.set(key, value); }),
}));
vi.mock('../src/lib/chain.js', () => ({ NATIVE_TOKEN: NATIVE, normAddress: (value: string) => value.toLowerCase() }));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/router.js', () => ({ pingRouterAbi: [] }));
vi.mock('../src/lib/viem.js', () => ({ publicClient: {
  getBlockNumber: vi.fn(async () => 42n),
  getBalance: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => { state.blocks.push(blockNumber); return state.native; }),
  readContract: vi.fn(async ({ address, functionName, args, blockNumber }:
    { address: string; functionName: string; args?: unknown[]; blockNumber: bigint }) => {
    state.blocks.push(blockNumber);
    if (state.fail) throw new Error('rpc down');
    if (functionName === 'feesAccrued') return state.feesAccrued;
    if (functionName === 'totalOwed') return state.totalOwed;
    if (functionName === 'escrows') return state.escrows.get(args![0] as string) ?? [ZERO, 0n, ZERO, 0n, 0n];
    if (functionName === 'balanceOf') return state.tokens.get(address) ?? 0n;
    throw new Error(`unexpected ${functionName}`);
  }),
} }));

import { logger } from '../src/lib/logger.js';
import { checkSolvency, insolventTokensKey, isTokenInsolvent } from '../src/modules/escrows/solvency.js';

describe('router solvency monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows = [{ id: '0x01' }, { id: '0x02' }, { id: '0x03' }];
    state.escrows = new Map([
      ['0x01', [SENDER, 1n, NATIVE, 1000n, 20n] as const],
      ['0x02', [SENDER, 1n, USDG, 500n, 20n] as const],
      // Closed on chain but not yet indexed: no obligation.
    ]);
    state.feesAccrued = 50n;
    state.totalOwed = 7n;
    state.native = 1000n + 40n + 50n + 7n;
    state.tokens = new Map([[USDG, 500n]]);
    state.blocks = [];
    state.kv = new Map();
    state.fail = false;
  });

  it('passes when balances cover principal, tips, fees and credited refunds, all at one block', async () => {
    await checkSolvency();
    expect(state.kv.get(insolventTokensKey)).toEqual([]);
    expect(new Set(state.blocks)).toEqual(new Set([42n]));
  });

  it('pauses only the token whose router balance fell short', async () => {
    state.tokens.set(USDG, 499n);
    await checkSolvency();
    expect(state.kv.get(insolventTokensKey)).toEqual([USDG]);
    expect(await isTokenInsolvent(USDG.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(await isTokenInsolvent(NATIVE)).toBe(false);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('counts credited ETH as a native obligation', async () => {
    state.native -= 1n;
    await checkSolvency();
    expect(state.kv.get(insolventTokensKey)).toEqual([NATIVE]);
  });

  it('keeps the previous verdict when the chain cannot be read', async () => {
    state.kv.set(insolventTokensKey, [USDG]);
    state.fail = true;
    await checkSolvency();
    expect(state.kv.get(insolventTokensKey)).toEqual([USDG]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
