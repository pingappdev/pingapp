import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  outerSelectResults: [] as unknown[][],
  txSelectResults: [] as unknown[][],
  txSelectCount: 0,
  claimJob: null as unknown,
  transactionHash: `0x${'99'.repeat(32)}`,
  blockTimestamp: 0n,
  broadcasts: 0,
  trace: [] as string[],
  updates: [] as Record<string, unknown>[],
  gas: 100_000n,
  writes: [] as Record<string, unknown>[],
  kvWrites: [] as [string, unknown][],
}));

vi.mock('../src/config.js', () => ({ config: {
  ROUTER_ENABLED: true,
  ROUTER_ADDRESS: '0x0000000000000000000000000000000000000003',
  ROUTER_DEPLOY_BLOCK: 1,
  RELAY_CLAIM_MAX_GAS: 300_000,
} }));
vi.mock('../src/db/schema.js', () => ({ escrows: 'escrows', kv: { key: 'key' }, phoneClaims: 'phoneClaims', users: 'users' }));
vi.mock('../src/db/client.js', () => {
  const query = (result: () => unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const name of ['from', 'where', 'limit', 'for']) chain[name] = () => chain;
    chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return chain;
  };
  const tx = {
    select: () => ({ from: () => query(() => {
      state.txSelectCount += 1;
      return state.txSelectResults.shift() ?? [];
    }) }),
    update: () => ({ set: (values: Record<string, unknown>) => {
      state.updates.push(values);
      state.trace.push('update');
      return { where: async () => undefined };
    } }),
    delete: () => ({ where: async () => undefined }),
  };
  return { db: {
    select: vi.fn(() => ({ from: () => query(() => state.outerSelectResults.shift() ?? []) })),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
      state.trace.push('transaction-start');
      const result = await callback(tx);
      state.trace.push('transaction-commit');
      return result;
    }),
  } };
});
vi.mock('drizzle-orm', () => ({
  and: (...values: unknown[]) => values,
  eq: (...values: unknown[]) => values,
  inArray: (...values: unknown[]) => values,
  lt: (...values: unknown[]) => values,
}));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    custom: vi.fn(() => ({ request: vi.fn(async () => null) })),
    createWalletClient: vi.fn(() => ({
      writeContract: vi.fn(async (request: Record<string, unknown>) => {
        state.writes.push(request);
        state.broadcasts += 1;
        state.trace.push('broadcast');
        return state.transactionHash;
      }),
    })),
  };
});
vi.mock('../src/db/kv.js', () => ({
  kvGet: vi.fn(async (_key: string, tx?: unknown) => {
    state.trace.push(tx ? 'outbox-read-in-transaction' : 'outbox-read');
    return state.claimJob;
  }),
  kvSet: vi.fn(async (key: string, value: unknown) => { state.kvWrites.push([key, value]); }),
}));
vi.mock('../src/db/notify.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/lib/cache.js', () => ({ invalidate: vi.fn(async () => undefined) }));
vi.mock('../src/lib/chain.js', () => ({
  normAddress: (value: string) => value.toLowerCase(),
  viemChain: { id: 4663 },
}));
vi.mock('../src/lib/crypto.js', async () => {
  const { createHash } = await import('node:crypto');
  return { phoneHmac: (value: string) => createHash('sha256').update(value).digest('hex') };
});
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/queue.js', () => ({ enqueue: vi.fn(async () => undefined), getQueue: vi.fn() }));
vi.mock('../src/lib/rpcPool.js', () => ({ rpc: vi.fn(async () => null) }));
vi.mock('../src/lib/router.js', () => ({
  getRelayerAccount: () => ({ address: '0x0000000000000000000000000000000000000009' }),
  pingRouterAbi: [],
}));
vi.mock('../src/lib/viem.js', () => ({ publicClient: {
  getBalance: vi.fn(async () => 1_000_000_000_000_000_000n),
  getBlock: vi.fn(async () => ({ timestamp: state.blockTimestamp })),
  simulateContract: vi.fn(async () => {
    state.trace.push('simulate');
    return { request: { to: '0x0000000000000000000000000000000000000003' } };
  }),
  estimateContractGas: vi.fn(async () => state.gas),
  waitForTransactionReceipt: vi.fn(async () => { throw new Error('receipt wait timed out'); }),
} }));
vi.mock('../src/modules/phone/lock.js', () => ({
  lockPhoneMutation: vi.fn(async () => { state.trace.push('phone-lock'); }),
}));
vi.mock('../src/modules/escrows/events.js', () => ({ applyRouterLog: vi.fn(), sendEscrowInvite: vi.fn() }));
vi.mock('../src/modules/escrows/ready.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/escrows/ready.js')>();
  return { ...actual, markEscrowsClaimable: vi.fn(async () => 0) };
});
vi.mock('../src/modules/escrows/service.js', () => ({
  claimJobKey: (id: string) => `router:claim:${id}`,
  claimRegisteredEscrow: vi.fn(async () => undefined),
  selfClaimKey: (id: string) => `router:self-claim:${id}`,
  enqueueClaim: vi.fn(async () => undefined),
}));
vi.mock('../src/modules/escrows/incident.js', () => ({
  assertRouterOperationEnabled: vi.fn(async () => undefined),
  isRouterIncidentStop: (error: unknown) => Boolean((error as { code?: string } | null)?.code === 'CONFLICT'),
}));

import { db } from '../src/db/client.js';
import { notify } from '../src/db/notify.js';
import { publicClient } from '../src/lib/viem.js';
import { relayClaim } from '../src/modules/escrows/jobs.js';
import { recipientRef } from '../src/modules/resolve/recipientRef.js';

const senderAddress = '0x0000000000000000000000000000000000000001';
const recipient = {
  id: 'recipient-id',
  address: '0x0000000000000000000000000000000000000002',
  phoneHmac: 'a'.repeat(64),
  phoneLinkedAt: new Date('2026-09-01T12:34:56.000Z'),
};
const escrowId = `0x${'11'.repeat(32)}`;

function setup(options: { recipientChange?: Record<string, unknown>; dispute?: boolean } = {}) {
  const job = {
    auth: {
      id: escrowId,
      recipient: recipient.address,
      relayer: '0x0000000000000000000000000000000000000009',
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
    },
    signature: `0x${'aa'.repeat(65)}`,
  };
  const escrow = {
    id: escrowId,
    senderUserId: 'sender-id',
    senderAddress,
    recipientPhoneHmac: recipient.phoneHmac,
    recipientPhoneEnc: 'encrypted-phone',
    recipientPhoneMasked: '***0102',
    recipientUserId: recipient.id,
    recipientRef: recipientRef(senderAddress, recipient.phoneHmac, recipient),
    deliveryMode: 'automatic',
    status: 'claiming',
    claimTxHash: null,
  };
  const freshRecipient = { ...recipient, ...options.recipientChange };
  state.outerSelectResults = [[escrow]];
  state.txSelectResults = [
    [escrow],
    [freshRecipient],
    options.dispute ? [{ id: 'pending-dispute' }] : [],
  ];
  state.txSelectCount = 0;
  state.claimJob = job;
  state.transactionHash = `0x${'99'.repeat(32)}`;
  state.blockTimestamp = BigInt(Math.floor(Date.now() / 1000));
  state.broadcasts = 0;
  state.trace = [];
  state.updates = [];
  state.gas = 100_000n;
  state.writes = [];
  state.kvWrites = [];
  return { job, escrow, freshRecipient };
}

describe('queued automatic escrow relay privacy revalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it.each([
    ['binding changed after the claim job was queued', { recipientChange: { phoneLinkedAt: new Date('2026-10-01T12:34:56.000Z') } }],
    ['a phone ownership dispute opened after the claim job was queued', { dispute: true }],
  ])('resets the queued claim without simulation or broadcast when %s', async (_case, options) => {
    const { job } = setup(options);

    await relayClaim(job as never);

    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    expect(state.broadcasts).toBe(0);
    expect(state.updates).toContainEqual({ status: 'deposited', claimTxHash: null, recipientUserId: null });
  });

  it('holds the phone lock through a valid broadcast and stores the returned transaction hash', async () => {
    const { job } = setup();

    await expect(relayClaim(job as never)).rejects.toThrow('receipt wait timed out');

    expect(publicClient.simulateContract).toHaveBeenCalledOnce();
    expect(state.broadcasts).toBe(1);
    expect(state.updates).toContainEqual({ claimTxHash: state.transactionHash });
    expect(state.trace.indexOf('phone-lock')).toBeLessThan(state.trace.indexOf('simulate'));
    expect(state.trace.indexOf('simulate')).toBeLessThan(state.trace.indexOf('broadcast'));
    expect(state.trace.indexOf('broadcast')).toBeLessThan(state.trace.indexOf('update'));
    expect(state.trace).toContain('outbox-read-in-transaction');
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(state.writes[0]).toMatchObject({ gas: 120_000n });
  });

  it('leaves a claim above the relay gas ceiling for the recipient to self-claim', async () => {
    const { job } = setup();
    state.gas = 300_001n;

    await relayClaim(job as never);

    expect(state.broadcasts).toBe(0);
    expect(state.updates).toContainEqual({ status: 'deposited', claimTxHash: null });
    expect(state.kvWrites).toContainEqual([`router:self-claim:${escrowId}`, true]);
    expect(notify).toHaveBeenCalledWith(recipient.id, 'escrow_incoming', { escrowId }, expect.anything());
  });
});
