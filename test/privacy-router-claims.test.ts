import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  selectCount: 0,
  updates: [] as Record<string, unknown>[],
}));

vi.mock('../src/config.js', () => ({ config: { ROUTER_ENABLED: true } }));
vi.mock('../src/db/schema.js', () => ({ escrows: 'escrows', phoneClaims: 'phoneClaims', users: 'users' }));
vi.mock('../src/db/client.js', () => {
  const query = () => {
    const chain: Record<string, unknown> = {};
    for (const name of ['where', 'limit', 'for']) chain[name] = () => chain;
    chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(state.selectResults[state.selectCount++] ?? []).then(resolve, reject);
    return chain;
  };
  const tx = {
    select: () => ({ from: () => query() }),
    update: () => ({ set: (values: Record<string, unknown>) => {
      state.updates.push(values);
      const chain = { where: async () => undefined };
      return chain;
    } }),
  };
  return { db: { transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(tx)) } };
});
vi.mock('drizzle-orm', () => ({ and: (...values: unknown[]) => values, eq: (...values: unknown[]) => values }));
vi.mock('../src/db/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/db/kv.js', () => ({ kvSet: vi.fn(async () => undefined) }));
vi.mock('../src/db/notify.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('../src/lib/chain.js', () => ({ normAddress: (value: string) => value.toLowerCase() }));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/crypto.js', async () => {
  const { createHash } = await import('node:crypto');
  return { phoneHmac: (value: string) => createHash('sha256').update(value).digest('hex') };
});
vi.mock('../src/lib/queue.js', () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock('../src/lib/router.js', () => ({
  getRelayerAccount: () => ({ address: '0x0000000000000000000000000000000000000009' }),
  serializeRouterAuth: (auth: unknown) => auth,
  signClaimAuth: vi.fn(async () => `0x${'ab'.repeat(65)}`),
}));
vi.mock('../src/lib/viem.js', () => ({ publicClient: {} }));
vi.mock('../src/modules/phone/lock.js', () => ({ lockPhoneMutation: vi.fn(async () => undefined) }));
vi.mock('../src/modules/tokens/minimum.js', () => ({ getMinAmountRaw: vi.fn(async () => '1') }));
vi.mock('../src/modules/tokens/prices.js', () => ({ getPrices: vi.fn(async () => new Map()) }));
vi.mock('../src/modules/tokens/routes.js', () => ({ toTokenDto: vi.fn(() => ({})) }));

import { db } from '../src/db/client.js';
import { kvSet } from '../src/db/kv.js';
import { enqueue } from '../src/lib/queue.js';
import { signClaimAuth } from '../src/lib/router.js';
import { claimRegisteredEscrow } from '../src/modules/escrows/service.js';
import { matchesEscrowRecipient } from '../src/modules/escrows/ready.js';
import { recipientRef } from '../src/modules/resolve/recipientRef.js';

const phoneHmacValue = 'a'.repeat(64);
const senderAddress = '0x0000000000000000000000000000000000000001';
const recipient = {
  id: 'recipient-id',
  address: '0x0000000000000000000000000000000000000002',
  phoneHmac: phoneHmacValue,
  phoneLinkedAt: new Date('2026-09-01T12:34:56.000Z'),
} as Parameters<typeof matchesEscrowRecipient>[1];

function escrow(overrides: Record<string, unknown> = {}): Parameters<typeof matchesEscrowRecipient>[0] {
  const row = {
    id: `0x${'11'.repeat(32)}`,
    senderUserId: 'sender-id',
    senderAddress,
    recipientPhoneHmac: phoneHmacValue,
    recipientPhoneEnc: 'encrypted-phone',
    recipientPhoneMasked: '***0102',
    deliveryMode: 'automatic',
    recipientRef: recipientRef(senderAddress, phoneHmacValue, recipient),
    status: 'deposited',
    depositedAt: new Date('2026-10-01T12:00:00.000Z'),
    depositTxHash: `0x${'22'.repeat(32)}`,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  return { ...row, ...overrides } as Parameters<typeof matchesEscrowRecipient>[0];
}

function setup(results: unknown[][]) {
  state.selectResults = results;
  state.selectCount = 0;
  state.updates = [];
}

describe('automatic escrow payout privacy gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup([]);
  });

  it('does not sign or enqueue a claim before a verified deposit is recorded', async () => {
    setup([[escrow({ status: 'authorized', depositedAt: null, depositTxHash: null })]]);

    await claimRegisteredEscrow(`0x${'11'.repeat(32)}`);

    expect(signClaimAuth).not.toHaveBeenCalled();
    expect(kvSet).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('blocks automatic payout while a phone ownership dispute is pending review', async () => {
    setup([[escrow()], [recipient], [{ id: 'pending-claim-id' }]]);

    await claimRegisteredEscrow(`0x${'11'.repeat(32)}`);

    expect(signClaimAuth).not.toHaveBeenCalled();
    expect(kvSet).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it.each([
    ['wallet changed after authorization', { address: '0x0000000000000000000000000000000000000004' }],
    ['phone relinked after authorization', { phoneLinkedAt: new Date('2026-10-01T12:34:56.000Z') }],
  ])('denies an automatic payout when the %s', async (_case, change) => {
    const changedRecipient = { ...recipient, ...change };
    setup([[escrow()], [changedRecipient]]);

    expect(matchesEscrowRecipient(escrow(), changedRecipient)).toBe(false);
    await claimRegisteredEscrow(`0x${'11'.repeat(32)}`);

    expect(signClaimAuth).not.toHaveBeenCalled();
    expect(kvSet).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });
});
