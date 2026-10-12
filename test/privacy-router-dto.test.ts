import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  transferCandidates: [] as Record<string, unknown>[],
}));

vi.mock('../src/config.js', () => ({ config: { APP_URL: 'https://app.example.test' } }));
vi.mock('../src/db/schema.js', () => ({
  contacts: {
    id: 'contacts.id', userId: 'contacts.userId', name: 'contacts.name', phoneHmac: 'contacts.phoneHmac',
    phoneEnc: 'contacts.phoneEnc', phoneMasked: 'contacts.phoneMasked',
    createdAt: 'contacts.createdAt', updatedAt: 'contacts.updatedAt',
  },
  intents: {
    id: 'intents.id', code: 'intents.code', status: 'intents.status', senderUserId: 'intents.senderUserId',
    recipientPhoneHmac: 'intents.recipientPhoneHmac', recipientUserId: 'intents.recipientUserId',
    tokenAddress: 'intents.tokenAddress', expiresAt: 'intents.expiresAt', createdAt: 'intents.createdAt',
    completedAt: 'intents.completedAt',
  },
  phoneClaims: { id: 'phoneClaims.id', phoneHmac: 'phoneClaims.phoneHmac', status: 'phoneClaims.status' },
  tokens: { address: 'tokens.address' },
  transfers: {
    __table: 'transfers', id: 'transfers.id', senderUserId: 'transfers.senderUserId',
    recipientPhoneHmac: 'transfers.recipientPhoneHmac', recipientAddress: 'transfers.recipientAddress',
    status: 'transfers.status',
  },
  users: {
    id: 'users.id', address: 'users.address', displayName: 'users.displayName', phoneHmac: 'users.phoneHmac',
    phoneLinkedAt: 'users.phoneLinkedAt',
  },
}));
vi.mock('../src/db/client.js', () => {
  const query = () => {
    const chain: Record<string, unknown> = {};
    let table: unknown;
    let predicate: unknown;
    for (const name of ['leftJoin', 'innerJoin', 'orderBy', 'limit']) chain[name] = () => chain;
    chain.from = (value: unknown) => { table = value; return chain; };
    chain.where = (value: unknown) => { predicate = value; return chain; };
    chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => {
      const isTransferQuery = (table as { __table?: string } | undefined)?.__table === 'transfers';
      const rows = isTransferQuery
        ? state.transferCandidates.filter((row) => matchesTransferPredicate(predicate, row))
        : state.queryResults.shift() ?? [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  };
  return { db: { select: vi.fn(() => query()), transaction: vi.fn() } };
});
vi.mock('drizzle-orm', () => ({
  and: (...values: unknown[]) => ({ op: 'and', values }),
  asc: (...values: unknown[]) => values,
  count: () => 'count',
  desc: (...values: unknown[]) => values,
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  gt: (...values: unknown[]) => values,
  inArray: (...values: unknown[]) => values,
  or: (...values: unknown[]) => values,
  sql: (...values: unknown[]) => values,
}));
vi.mock('../src/db/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/chain.js', () => ({
  checksum: (value: string) => value,
  normAddress: (value: string) => value.toLowerCase(),
}));
vi.mock('../src/lib/crypto.js', async () => {
  const { createHash } = await import('node:crypto');
  return {
    decrypt: (value: string) => value,
    encrypt: (value: string) => value,
    phoneHmac: (value: string) => createHash('sha256').update(value).digest('hex'),
  };
});
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/rateLimit.js', () => ({
  consume: vi.fn(async () => undefined),
  limits: { resolveIpDay: 'resolve-ip', resolveUserDay: 'resolve-day', resolveUserMin: 'resolve-min' },
}));
vi.mock('../src/lib/redis.js', () => ({ redis: { eval: vi.fn(async () => 1) } }));
vi.mock('../src/modules/escrows/public.js', () => ({ getEscrowClaim: vi.fn(async () => null) }));
vi.mock('../src/modules/phone/lock.js', () => ({ lockPhoneMutation: vi.fn(async () => undefined) }));
vi.mock('../src/modules/tokens/minimum.js', () => ({ getMinAmountRaw: vi.fn(async () => '1') }));
vi.mock('../src/modules/tokens/prices.js', () => ({ getPrices: vi.fn(async () => new Map()) }));
vi.mock('../src/modules/tokens/routes.js', () => ({ toTokenDto: vi.fn(() => ({ symbol: 'USDG' })) }));

import { resolvePhone } from '../src/modules/resolve/service.js';
import { list as listContacts } from '../src/modules/contacts/service.js';
import { toIntentDto } from '../src/modules/intents/service.js';
import { phoneHmac } from '../src/lib/crypto.js';

const senderAddress = '0x0000000000000000000000000000000000000001';
const recipientAddress = '0x0000000000000000000000000000000000000002';
const linkedAt = new Date('2026-08-21T06:07:08.000Z');
const phone = '+12025550102';

type Predicate = { op?: string; values?: unknown[]; column?: unknown; value?: unknown };
function matchesTransferPredicate(expression: unknown, row: Record<string, unknown>): boolean {
  const predicate = expression as Predicate | null;
  if (!predicate) return true;
  if (predicate.op === 'and') return (predicate.values ?? []).every((part) => matchesTransferPredicate(part, row));
  if (predicate.op === 'eq') {
    const field = String(predicate.column).split('.').at(-1)!;
    return row[field] === predicate.value;
  }
  return true;
}

async function resolveRecipientWithTransfer(candidate: Record<string, unknown>) {
  state.queryResults = [
    [{ phoneHmac: 'sender-hmac' }],
    [{ address: recipientAddress, displayName: 'Recipient', phoneLinkedAt: linkedAt }],
    [],
  ];
  state.transferCandidates = [candidate];
  const result = await resolvePhone({ id: 'sender-id', address: senderAddress } as never, phone, 'ip-hash');
  if (result.status !== 'registered') throw new Error('Expected a registered recipient fixture.');
  return result.recipient.previouslySentByMe;
}

describe('pre-payment recipient DTO privacy', () => {
  it('keeps resolution to an opaque binding reference without wallet or link-time fields', async () => {
    state.transferCandidates = [];
    state.queryResults = [
      [{ phoneHmac: 'sender-hmac' }],
      [{ address: recipientAddress, displayName: 'Recipient', phoneLinkedAt: linkedAt }],
      [],
      [],
    ];

    const result = await resolvePhone({ id: 'sender-id', address: senderAddress } as never, phone, 'ip-hash');
    if (result.status !== 'registered') throw new Error('Expected a registered recipient fixture.');
    const recipient = result.recipient;

    expect(result.status).toBe('registered');
    expect(recipient).toHaveProperty('recipientRef');
    expect(JSON.stringify(result)).not.toContain(recipientAddress);
    expect(JSON.stringify(result)).not.toContain(linkedAt.toISOString());
    expect(result).not.toHaveProperty('linkedAt');
    expect(recipient).not.toHaveProperty('address');
    expect(recipient).not.toHaveProperty('phoneLinkedAt');
    expect(recipient).not.toHaveProperty('recentlyLinked');
  });

  it('omits matched PingApp wallet and link-time data from contacts', async () => {
    state.queryResults = [[{
      contact: {
        id: 'contact-id', name: 'Phone contact', phoneEnc: '+12025550102', phoneMasked: '***0102',
        createdAt: new Date('2026-10-02T06:07:08.000Z'),
      },
      paId: 'matched-user-id',
      paName: 'Recipient',
      paAddress: recipientAddress,
      paLinkedAt: linkedAt,
    }]];

    const [contact] = await listContacts('sender-id');

    expect(contact.onPingApp).toEqual({ displayName: 'Recipient' });
    expect(JSON.stringify(contact)).not.toContain(recipientAddress);
    expect(JSON.stringify(contact)).not.toContain(linkedAt.toISOString());
    expect(contact.onPingApp).not.toHaveProperty('address');
    expect(contact.onPingApp).not.toHaveProperty('linkedAt');
    expect(contact.onPingApp).not.toHaveProperty('previouslySentByMe');
  });

  it('keeps legacy intent recipient DTOs name-only and clears pre-fund readiness dates', async () => {
    const intent = {
      id: 'intent-id', code: 'ABCDEFGHIJ', status: 'ready', smsStatus: 'sent', recipientPhoneMasked: '***0102',
      amountRaw: '1000000', note: null, transferId: null, expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      createdAt: new Date('2026-10-02T06:07:08.000Z'), readyAt: linkedAt, completedAt: null,
    };
    const token = {
      address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 6, symbol: 'USDG',
    };

    const dto = await toIntentDto(intent as never, token as never, { displayName: 'Recipient' }, new Map());

    expect(dto.recipient).toEqual({ displayName: 'Recipient' });
    expect(dto.readyAt).toBeNull();
    expect(JSON.stringify(dto)).not.toContain(recipientAddress);
    expect(JSON.stringify(dto)).not.toContain(linkedAt.toISOString());
  });

  it.each([
    ['a funded transfer to the same wallet with no phone metadata', { recipientPhoneHmac: null }, false],
    ['a funded transfer to the same wallet with a different phone', { recipientPhoneHmac: 'other-phone-hmac' }, false],
    ['a funded transfer to the same wallet and phone from this sender', { recipientPhoneHmac: phoneHmac(phone) }, true],
    ['a funded transfer to the same wallet and phone from another sender', { senderUserId: 'other-sender-id', recipientPhoneHmac: phoneHmac(phone) }, false],
    ['a submitted transfer to the same wallet and phone', { status: 'submitted', recipientPhoneHmac: phoneHmac(phone) }, false],
  ])('sets the prior-send hint only for %s', async (_case, overrides, expected) => {
    const row = Object.assign({
      id: 'transfer-id', senderUserId: 'sender-id', recipientAddress, recipientPhoneHmac: phoneHmac(phone), status: 'confirmed',
    }, overrides);

    await expect(resolveRecipientWithTransfer(row)).resolves.toBe(expected);
  });
});
