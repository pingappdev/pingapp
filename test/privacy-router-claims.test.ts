import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  selectCount: 0,
  updates: [] as Record<string, unknown>[],
  authorizations: [] as Record<string, unknown>[],
  trace: [] as string[],
  failCommit: false,
  selfClaim: false,
}));

vi.mock('../src/config.js', () => ({ config: { ROUTER_ENABLED: true, ROUTER_ADDRESS: '0x0000000000000000000000000000000000000003' } }));
vi.mock('../src/db/schema.js', () => ({ claimAuthorizations: 'claimAuthorizations', escrows: 'escrows', phoneClaims: 'phoneClaims', users: 'users' }));
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
    insert: () => ({ values: async (values: Record<string, unknown>) => {
      state.authorizations.push(values);
      state.trace.push('authorization-insert');
    } }),
    update: () => ({ set: (values: Record<string, unknown>) => {
      state.updates.push(values);
      const chain = { where: async () => undefined };
      return chain;
    } }),
  };
  return { db: { transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
    state.trace.push('transaction-start');
    const result = await callback(tx);
    state.trace.push('transaction-commit');
    if (state.failCommit) throw new Error('synthetic database commit failure');
    return result;
  }) } };
});
vi.mock('drizzle-orm', () => ({ and: (...values: unknown[]) => values, eq: (...values: unknown[]) => values }));
vi.mock('../src/db/audit.js', () => ({ audit: vi.fn(async () => { state.trace.push('audit'); }) }));
vi.mock('../src/db/kv.js', () => ({
  kvGet: vi.fn(async (key: string) => (key.startsWith('router:self-claim:') && state.selfClaim ? true : undefined)),
  kvSet: vi.fn(async () => undefined),
}));
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
  hashClaimAuth: vi.fn(() => `0x${'cd'.repeat(32)}`),
  routerDomain: { name: 'PingRouter', version: '1', chainId: 4663, verifyingContract: '0x0000000000000000000000000000000000000003' },
  serializeRouterAuth: (auth: unknown) => auth,
  signClaimAuth: vi.fn(async () => { state.trace.push('sign'); return `0x${'ab'.repeat(65)}`; }),
}));
vi.mock('../src/modules/escrows/incident.js', () => ({
  assertRouterOperationEnabled: vi.fn(async () => undefined),
  isRouterIncidentStop: (error: unknown) => Boolean((error as { code?: string } | null)?.code === 'CONFLICT'),
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
import { claimEscrow, claimRegisteredEscrow, selfClaimEscrow } from '../src/modules/escrows/service.js';
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
  state.authorizations = [];
  state.trace = [];
  state.failCommit = false;
  state.selfClaim = false;
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

describe('self-claim after the relay gas ceiling', () => {
  const id = `0x${'11'.repeat(32)}`;
  const user = { id: recipient.id, address: recipient.address } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    setup([]);
  });

  it('stops automatic relays once an escrow is marked for self-claim', async () => {
    setup([[escrow()], [recipient], []]);
    state.selfClaim = true;

    await claimRegisteredEscrow(id);

    expect(signClaimAuth).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('refuses a relayed claim request for a self-claim escrow', async () => {
    setup([[escrow({ recipientUserId: recipient.id })], [recipient], []]);
    state.selfClaim = true;

    await expect(claimEscrow(user, id, 'ip')).rejects.toThrow('Claim it from your wallet');
    expect(signClaimAuth).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('signs a claim the recipient relays to their own wallet, without changing status', async () => {
    setup([[escrow({ recipientUserId: recipient.id })], [recipient], []]);
    state.selfClaim = true;

    const result = await selfClaimEscrow(user, id, 'ip');

    expect(result.auth).toMatchObject({ id, recipient: recipient.address, relayer: recipient.address });
    expect(signClaimAuth).toHaveBeenCalledOnce();
    expect(state.authorizations[0]).toMatchObject({
      escrowId: id, kind: 'self', recipientUserId: recipient.id, recipientAddress: recipient.address,
      relayerAddress: recipient.address, recipientPhoneHmac: phoneHmacValue,
      domainName: 'PingRouter', domainVersion: '1', domainChainId: 4663n,
      domainVerifyingContract: '0x0000000000000000000000000000000000000003',
      typedDataDigest: `0x${'cd'.repeat(32)}`,
    });
    expect(state.authorizations[0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(state.authorizations[0].deadline).toBeInstanceOf(Date);
    expect(state.trace.indexOf('authorization-insert')).toBeLessThan(state.trace.indexOf('sign'));
    expect(state.trace.indexOf('sign')).toBeLessThan(state.trace.indexOf('transaction-commit'));
    expect(state.updates).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not release a self-claim signature when its evidence transaction fails to commit', async () => {
    setup([[escrow({ recipientUserId: recipient.id })], [recipient], []]);
    state.selfClaim = true;
    state.failCommit = true;

    await expect(selfClaimEscrow(user, id, 'ip')).rejects.toThrow('synthetic database commit failure');

    expect(state.authorizations).toHaveLength(1);
    expect(signClaimAuth).toHaveBeenCalledOnce();
  });

  it('does not sign a self-claim while the relayer still delivers the escrow', async () => {
    setup([[escrow({ recipientUserId: recipient.id })], [recipient], []]);

    await expect(selfClaimEscrow(user, id, 'ip')).rejects.toThrow('delivered by the relayer');
    expect(signClaimAuth).not.toHaveBeenCalled();
  });

  it('does not sign a self-claim for anyone but the bound recipient', async () => {
    setup([[escrow({ recipientUserId: 'someone-else' })], [recipient], []]);
    state.selfClaim = true;

    await expect(selfClaimEscrow(user, id, 'ip')).rejects.toThrow();
    expect(signClaimAuth).not.toHaveBeenCalled();
  });
});
