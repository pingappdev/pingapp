import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  inserted: null as Record<string, unknown> | null,
  transactionCount: 0,
}));

vi.mock('../src/config.js', () => ({ config: {
  ROUTER_ENABLED: true,
  ROUTER_ADDRESS: '0x0000000000000000000000000000000000000003',
  ROUTER_AUTH_TTL_SECONDS: 600,
  ESCROW_CLAIM_TIP_WEI: '20',
  INTENT_TTL_DAYS: 14,
} }));
vi.mock('../src/db/schema.js', () => ({
  contacts: 'contacts', escrows: 'escrows', intents: 'intents', users: 'users',
}));
vi.mock('../src/db/client.js', () => {
  const query = (result: () => unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const name of ['where', 'limit', 'for']) {
      chain[name] = () => chain;
    }
    chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return chain;
  };
  const tx = {
    select: () => ({ from: () => query(() => state.selectResults.shift() ?? []) }),
    insert: () => ({ values: (values: Record<string, unknown>) => {
      state.inserted = values;
      const insert = {
        onConflictDoNothing: () => insert,
        returning: async () => [{ ...values, code: 'ABCDEFGHIJ' }],
      };
      return insert;
    } }),
  };
  return { db: {
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
      state.transactionCount += 1;
      return callback(tx);
    }),
  } };
});
vi.mock('drizzle-orm', () => ({ and: (...values: unknown[]) => values, eq: (...values: unknown[]) => values }));
vi.mock('../src/db/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/chain.js', () => ({
  isAddress: (value: string) => /^0x[\da-f]{40}$/i.test(value),
  normAddress: (value: string) => value.toLowerCase(),
}));
vi.mock('../src/lib/crypto.js', async () => {
  const { createHash } = await import('node:crypto');
  return {
    encrypt: (value: string) => `encrypted:${value}`,
    phoneHmac: (value: string) => createHash('sha256').update(value).digest('hex'),
    randomCode: () => 'ABCDEFGHIJ',
  };
});
vi.mock('../src/lib/rateLimit.js', () => ({
  consume: vi.fn(async () => undefined), limits: { intentUserDay: 'intent-user-day' },
}));
vi.mock('../src/lib/router.js', () => ({
  getEscrowFee: vi.fn(async () => 5n),
  isNativeRouterToken: () => false,
  newRouterId: () => `0x${'12'.repeat(32)}`,
  serializeRouterAuth: (auth: Record<string, unknown>) => Object.fromEntries(
    Object.entries(auth).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]),
  ),
  signEscrowAuth: vi.fn(async () => `0x${'34'.repeat(65)}`),
  signClaimAuth: vi.fn(async () => `0x${'56'.repeat(65)}`),
}));
vi.mock('../src/modules/intents/service.js', () => ({ cleanNote: () => null }));
vi.mock('../src/modules/phone/lock.js', () => ({ lockPhoneMutation: vi.fn(async () => undefined) }));
vi.mock('../src/modules/tokens/minimum.js', () => ({ assertMinAmount: vi.fn(async () => undefined) }));
vi.mock('../src/modules/tokens/registry.js', () => ({ getToken: vi.fn(async () => ({
  address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 6, symbol: 'USDG',
})) }));

import { db } from '../src/db/client.js';
import { phoneHmac } from '../src/lib/crypto.js';
import { signClaimAuth, signEscrowAuth } from '../src/lib/router.js';
import { recipientRef } from '../src/modules/resolve/recipientRef.js';
import { authorizeSend } from '../src/modules/sends/service.js';

const sender = {
  id: 'sender-id',
  address: '0x0000000000000000000000000000000000000001',
  displayName: 'Sender',
  phoneHmac: 'sender-phone-hmac',
};
const recipient = {
  id: 'recipient-id',
  address: '0x0000000000000000000000000000000000000002',
  displayName: 'Recipient',
  phoneHmac: 'recipient-phone-hmac',
  phoneLinkedAt: new Date('2026-09-01T12:34:56.000Z'),
};
const user = { id: sender.id, address: sender.address };
const phone = '+12025550102';
const tokenAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function setDatabase(recipientRow = recipient) {
  state.selectResults = [[sender], [recipientRow], []];
  state.inserted = null;
}

describe('private recipient escrow authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.transactionCount = 0;
    setDatabase();
  });

  it('creates an escrow authorization without disclosing the recipient wallet or phone-link date', async () => {
    const targetHmac = phoneHmac(phone);
    const expectedRecipientRef = recipientRef(sender.address, targetHmac, recipient);
    const result = await authorizeSend(user, {
      phone,
      tokenAddress,
      amount: '1',
      expectedSenderAddress: sender.address,
      expectedRecipientRef,
    }, 'ip-hash');

    expect(result.mode).toBe('escrow');
    expect(result.deliveryMode).toBe('automatic');
    const publicResponse = JSON.stringify(result);
    expect(publicResponse).not.toContain(recipient.address);
    expect(publicResponse).not.toContain(recipient.phoneLinkedAt.toISOString());
    expect(publicResponse).not.toMatch(/recipientAddress|phoneLinkedAt|linkedAt|recentlyLinked/);
    expect(result).not.toHaveProperty('claimAuth');
    expect(result).not.toHaveProperty('recipient');

    expect(state.inserted).toMatchObject({ status: 'authorized', deliveryMode: 'automatic', recipientRef: expectedRecipientRef });
    expect(state.inserted).not.toHaveProperty('recipientAddress');
    expect(state.inserted).not.toHaveProperty('recipientUserId');
    expect(state.inserted).not.toHaveProperty('phoneLinkedAt');
    expect(state.inserted).not.toHaveProperty('linkedAt');
    expect(JSON.stringify(state.inserted)).not.toContain(recipient.address);

    expect(signEscrowAuth).toHaveBeenCalledOnce();
    expect(signClaimAuth).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it('rejects a stale opaque recipient reference before creating or signing an escrow', async () => {
    const previousBinding = { ...recipient, phoneLinkedAt: new Date('2026-08-01T12:34:56.000Z') };
    setDatabase(recipient);
    const staleRef = recipientRef(sender.address, phoneHmac(phone), previousBinding);

    const rejection = authorizeSend(user, {
      phone,
      tokenAddress,
      amount: '1',
      expectedSenderAddress: sender.address,
      expectedRecipientRef: staleRef,
    }, 'ip-hash').then(
      () => { throw new Error('Expected stale recipient reference to be rejected.'); },
      (error: unknown) => error,
    );
    const error = await rejection;

    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(recipient.address);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(recipient.phoneLinkedAt.toISOString());
    expect(state.inserted).toBeNull();
    expect(signEscrowAuth).not.toHaveBeenCalled();
    expect(signClaimAuth).not.toHaveBeenCalled();
  });

  it('binds opaque recipient references to both the sender and target phone', () => {
    const targetHmac = phoneHmac(phone);
    const original = recipientRef(sender.address, targetHmac, recipient);

    expect(recipientRef('0x0000000000000000000000000000000000000008', targetHmac, recipient)).not.toBe(original);
    expect(recipientRef(sender.address, `${targetHmac.slice(0, -1)}0`, recipient)).not.toBe(original);
  });
});
