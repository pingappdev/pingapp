import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  grants: new Map<string, string>(),
  indexedHashes: [] as string[],
  userRows: [] as Array<Record<string, unknown>>,
  selectedHashLists: [] as string[][],
  consumed: [] as Array<[string, string]>,
  redisEvalResult: 0,
}));

vi.mock('../src/db/schema.js', () => ({
  users: { id: 'users.id', phoneHmac: 'users.phoneHmac', address: 'users.address',
    displayName: 'users.displayName', phoneLinkedAt: 'users.phoneLinkedAt' },
  intents: { id: 'intents.id', status: 'intents.status', senderUserId: 'intents.senderUserId' },
  phoneClaims: { id: 'phoneClaims.id', phoneHmac: 'phoneClaims.phoneHmac', status: 'phoneClaims.status' },
  transfers: { id: 'transfers.id', senderUserId: 'transfers.senderUserId',
    recipientPhoneHmac: 'transfers.recipientPhoneHmac', recipientAddress: 'transfers.recipientAddress',
    status: 'transfers.status' },
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => {
      const query: Record<string, unknown> = {
        from: () => query,
        where: (filter: { values?: string[] }) => {
          if (filter?.values) state.selectedHashLists.push(filter.values);
          return query;
        },
        limit: () => query,
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => {
          const rows = state.userRows.filter((row) => {
            const selected = state.selectedHashLists.at(-1);
            return !selected || selected.includes(String(row.phoneHmac));
          });
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    },
  },
}));

vi.mock('../src/lib/redis.js', () => ({
  redis: {
    eval: vi.fn(async () => state.redisEvalResult),
    get: vi.fn(async (key: string) => state.grants.get(key) ?? null),
    smembers: vi.fn(async () => [...state.indexedHashes]),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => state.grants.get(key) ?? null)),
    srem: vi.fn(async (_key: string, ...hashes: string[]) => {
      state.indexedHashes = state.indexedHashes.filter((value) => !hashes.includes(value));
      return hashes.length;
    }),
    multi: () => {
      const commands: Array<() => void> = [];
      const chain = {
        set: (key: string, value: string) => { commands.push(() => state.grants.set(key, value)); return chain; },
        sadd: (_key: string, hash: string) => { commands.push(() => { if (!state.indexedHashes.includes(hash)) state.indexedHashes.push(hash); }); return chain; },
        expire: () => chain,
        exec: async () => { commands.forEach((command) => command()); return []; },
      };
      return chain;
    },
  },
}));

vi.mock('../src/lib/rateLimit.js', () => ({
  consume: vi.fn(async (limiter: string, key: string) => { state.consumed.push([limiter, key]); }),
  limits: {
    resolveUserMin: 'resolve-user-minute',
    resolveUserDay: 'resolve-user-day',
    resolveIpDay: 'resolve-ip-day',
  },
}));

vi.mock('../src/lib/crypto.js', () => ({ phoneHmac: (value: string) => value }));
vi.mock('../src/lib/phone.js', () => ({ normalizePhone: (value: string) => ({ e164: value, masked: value }) }));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn() } }));
vi.mock('drizzle-orm', () => ({
  and: (...values: unknown[]) => values,
  count: () => 'count',
  eq: (...values: unknown[]) => values,
  inArray: (column: string, values: string[]) => ({ column, values }),
}));

import { phoneMembershipsForContacts, requirePhoneDiscoveryGrant, isPhoneDiscoveryGrantCurrent } from '../src/modules/resolve/service.js';
import { redis } from '../src/lib/redis.js';
import { consume } from '../src/lib/rateLimit.js';

const recipientLinkedAt = new Date('2026-10-16T09:00:00.000Z');
const registeredGrant = {
  version: 1 as const,
  status: 'registered' as const,
  recipientUserId: 'recipient-1',
  phoneLinkedAt: recipientLinkedAt.toISOString(),
};

function setGrant(userId: string, phoneHash: string, grant: unknown) {
  const key = `resolve:grant:${userId}:${phoneHash}`;
  state.grants.set(key, JSON.stringify(grant));
  if (!state.indexedHashes.includes(phoneHash)) state.indexedHashes.push(phoneHash);
}

describe('phone discovery grants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.grants.clear();
    state.indexedHashes = [];
    state.userRows = [];
    state.selectedHashLists = [];
    state.consumed = [];
    state.redisEvalResult = 0;
  });

  it('keeps an unchecked contact distinct from a confirmed unregistered number', async () => {
    const memberships = await phoneMembershipsForContacts('sender-1', ['unchecked']);
    expect(memberships.get('unchecked')).toEqual({ membershipStatus: 'unknown', onPingApp: null });
    expect(state.selectedHashLists).toEqual([]);
  });

  it('returns current membership only for a matching, unexpired grant', async () => {
    setGrant('sender-1', 'phone-a', registeredGrant);
    state.userRows = [{ phoneHmac: 'phone-a', id: 'recipient-1', address: '0x1',
      displayName: 'Ari', phoneLinkedAt: recipientLinkedAt }];

    const memberships = await phoneMembershipsForContacts('sender-1', ['phone-a', 'phone-b']);
    expect(memberships.get('phone-a')).toEqual({
      membershipStatus: 'registered', onPingApp: { displayName: 'Ari' },
    });
    expect(memberships.get('phone-b')).toEqual({ membershipStatus: 'unknown', onPingApp: null });
    expect(state.selectedHashLists).toEqual([['phone-a']]);
  });

  it('marks a registration or binding change unknown until the user resolves again', async () => {
    setGrant('sender-1', 'phone-a', registeredGrant);
    state.userRows = [{ phoneHmac: 'phone-a', id: 'recipient-2', address: '0x2',
      displayName: 'New owner', phoneLinkedAt: recipientLinkedAt }];
    const memberships = await phoneMembershipsForContacts('sender-1', ['phone-a']);
    expect(memberships.get('phone-a')).toEqual({ membershipStatus: 'unknown', onPingApp: null });

    expect(isPhoneDiscoveryGrantCurrent(registeredGrant, {
      id: 'recipient-1', phoneLinkedAt: new Date(recipientLinkedAt.getTime() + 1),
    })).toBe(false);
  });

  it('does not keep a not-registered assertion after a number is linked', async () => {
    setGrant('sender-1', 'phone-a', { version: 1, status: 'not_registered' });
    state.userRows = [{ phoneHmac: 'phone-a', id: 'recipient-1', address: '0x1',
      displayName: 'Ari', phoneLinkedAt: recipientLinkedAt }];
    const memberships = await phoneMembershipsForContacts('sender-1', ['phone-a']);
    expect(memberships.get('phone-a')).toEqual({ membershipStatus: 'unknown', onPingApp: null });
  });

  it('requires the same discovery budgets before send authorization can expose binding differences', async () => {
    await expect(requirePhoneDiscoveryGrant('sender-1', 'phone-a', 'ip-hash'))
      .rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(consume).toHaveBeenCalledTimes(3);
    expect(state.consumed).toEqual([
      ['resolve-user-minute', 'sender-1'],
      ['resolve-user-day', 'sender-1'],
      ['resolve-ip-day', 'ip-hash'],
    ]);
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it('accepts only an existing short-lived phone grant after applying the budgets', async () => {
    setGrant('sender-1', 'phone-a', registeredGrant);
    await expect(requirePhoneDiscoveryGrant('sender-1', 'phone-a', 'ip-hash')).resolves.toEqual(registeredGrant);
  });
});
