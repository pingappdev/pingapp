import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  cards: new Map<string, Record<string, unknown>>(),
  mode: 'live' as 'live' | 'sandbox',
  armResponse: null as unknown,
  codeResponse: null as unknown,
  armCalls: 0,
  codeCalls: 0,
}));

vi.mock('../src/config.js', () => ({ config: new Proxy({}, { get: (_t, key) => (key === 'IZIPAY_MODE' ? state.mode : undefined) }) }));
vi.mock('../src/lib/redis.js', () => ({ redis: {
  get: vi.fn(async (key: string) => state.store.get(key) ?? null),
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    if (args.includes('NX') && state.store.has(key)) return null;
    state.store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => { keys.forEach((key) => state.store.delete(key)); return keys.length; }),
  // Emulates the two Lua scripts in applePay.ts.
  eval: vi.fn(async (script: string, _n: number, key: string, ...args: string[]) => {
    const current = state.store.get(key);
    const holder = current ? (JSON.parse(current) as { cardId: string }).cardId : null;
    if (script.includes("'SET'")) {
      if (holder && holder !== args[1]) return -420;
      state.store.set(key, args[0]);
      return 1;
    }
    if (holder === args[0]) { state.store.delete(key); return 1; }
    return 0;
  }),
} }));
vi.mock('../src/modules/cards/service.js', () => ({
  ownCard: vi.fn(async (userId: string, id: string) => {
    const card = state.cards.get(id);
    if (!card || card.userId !== userId) throw Object.assign(new Error('Not found.'), { code: 'NOT_FOUND' });
    return card;
  }),
}));
vi.mock('../src/modules/cards/provider.js', () => ({
  providerRedisPrefix: 'cards:provider:test',
  provider: {
    armApplePay: vi.fn(async () => { state.armCalls += 1; if (state.armResponse instanceof Error) throw state.armResponse; return state.armResponse; }),
    applePayCode: vi.fn(async () => { state.codeCalls += 1; return state.codeResponse; }),
  },
}));
vi.mock('../src/modules/cards/settings.js', () => ({
  requireCards: () => undefined,
  unavailable: () => Object.assign(new Error('Cards are temporarily unavailable.'), { code: 'CARDS_UNAVAILABLE' }),
  encryptCardData: (plain: string, context: string) => `enc:${context}:${Buffer.from(plain).toString('base64')}`,
  decryptCardData: (blob: string, context: string) => {
    const prefix = `enc:${context}:`;
    if (!blob.startsWith(prefix)) throw new Error('bad context');
    return Buffer.from(blob.slice(prefix.length), 'base64').toString();
  },
}));

import { armApplePay, getApplePayCode } from '../src/modules/cards/applePay.js';

const USER = 'user-a', OTHER = 'user-b';
const card = (id: string, userId: string, product = 'mastercard', providerCardId = `card_${id}`) =>
  state.cards.set(id, { id, userId, product, issueStatus: 'issued', providerCardId });

describe('Apple Pay activation codes', () => {
  beforeEach(() => {
    state.store.clear();
    state.cards.clear();
    state.mode = 'live';
    state.armCalls = 0;
    state.codeCalls = 0;
    card('a', USER);
    card('b', OTHER);
    state.armResponse = { card_id: 'card_a', status: 'armed', expires_in: 600 };
    state.codeResponse = { card_id: 'card_a', status: 'waiting' };
  });

  it('arms a Mastercard and waits for the code', async () => {
    const armed = await armApplePay(USER, 'a');
    expect(armed.status).toBe('waiting');
    expect(state.armCalls).toBe(1);
    expect(await getApplePayCode(USER, 'a')).toMatchObject({ status: 'waiting' });
  });

  it('allows only one armed card across the provider account', async () => {
    await armApplePay(USER, 'a');
    state.armResponse = { card_id: 'card_b', status: 'armed' };
    await expect(armApplePay(OTHER, 'b')).rejects.toMatchObject({ code: 'APPLE_PAY_BUSY', details: { retryAfterSec: 420 } });
    expect(state.armCalls).toBe(1);
    // The other user's card never sees the first card's state.
    expect(await getApplePayCode(OTHER, 'b')).toEqual({ status: 'idle' });
  });

  it('lets the same card re-arm, and frees the lock when the provider refuses', async () => {
    await armApplePay(USER, 'a');
    await expect(armApplePay(USER, 'a')).resolves.toMatchObject({ status: 'waiting' });
    state.armResponse = new Error('provider down');
    await expect(armApplePay(USER, 'a')).rejects.toMatchObject({ code: 'CARDS_UNAVAILABLE' });
    state.armResponse = { card_id: 'card_b', status: 'armed' };
    await expect(armApplePay(OTHER, 'b')).resolves.toMatchObject({ status: 'waiting' });
  });

  it('throttles provider polls per card', async () => {
    await armApplePay(USER, 'a');
    await getApplePayCode(USER, 'a');
    await getApplePayCode(USER, 'a');
    await getApplePayCode(USER, 'a');
    expect(state.codeCalls).toBe(1);
  });

  it('returns a delivered code only to its owner, stores it encrypted, and releases the lock', async () => {
    await armApplePay(USER, 'a');
    state.codeResponse = { card_id: 'card_a', status: 'delivered', code: '481923', matched_at: '2026-10-12T10:00:00Z' };
    expect(await getApplePayCode(USER, 'a')).toMatchObject({ status: 'delivered', code: '481923' });
    const stored = [...state.store.entries()].find(([key]) => key.includes(':code:'));
    expect(stored?.[1]).not.toContain('481923');
    // Later reads use the cached code without asking the provider again.
    expect(await getApplePayCode(USER, 'a')).toMatchObject({ status: 'delivered', code: '481923' });
    expect(state.codeCalls).toBe(1);
    await expect(getApplePayCode(OTHER, 'a')).rejects.toThrow('Not found.');
    state.armResponse = { card_id: 'card_b', status: 'armed' };
    await expect(armApplePay(OTHER, 'b')).resolves.toMatchObject({ status: 'waiting' });
  });

  it('ignores a code reported for a different provider card or in an invalid shape', async () => {
    await armApplePay(USER, 'a');
    state.codeResponse = { card_id: 'card_other', status: 'delivered', code: '481923' };
    expect(await getApplePayCode(USER, 'a')).toMatchObject({ status: 'waiting' });
    state.store.delete('cards:provider:test:apple-pay:poll:a');
    state.codeResponse = { card_id: 'card_a', status: 'delivered', code: '<script>' };
    expect(await getApplePayCode(USER, 'a')).toMatchObject({ status: 'waiting' });
  });

  it('rejects other card types, sandbox mode and cards that are not issued', async () => {
    card('v', USER, 'visa');
    await expect(armApplePay(USER, 'v')).rejects.toMatchObject({ code: 'APPLE_PAY_UNSUPPORTED' });
    state.cards.set('p', { id: 'p', userId: USER, product: 'mastercard', issueStatus: 'pending_payment', providerCardId: null });
    await expect(armApplePay(USER, 'p')).rejects.toMatchObject({ code: 'CARD_NOT_READY' });
    state.mode = 'sandbox';
    await expect(armApplePay(USER, 'a')).rejects.toMatchObject({ code: 'APPLE_PAY_UNSUPPORTED' });
    expect(state.armCalls).toBe(0);
  });
});
