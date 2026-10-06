import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selections: [] as unknown[][], writes: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  plaintext: new Map<string, string>(), select: vi.fn(), insert: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
}));
vi.mock('../src/db/client.js', () => ({ db: { transaction: async (work: (tx: unknown) => unknown) => work({ select: state.select, insert: state.insert }) } }));
vi.mock('../src/modules/cards/provider.js', () => ({ provider: {} }));
vi.mock('../src/modules/cards/settings.js', () => ({
  providerScope: 'izipay:sandbox:unit-test', encryptCardData: state.encrypt, decryptCardData: state.decrypt,
  requireCards: vi.fn(), cardsEnabled: () => false, unavailable: vi.fn(),
}));
import { cardOperations, cardProfiles } from '../src/db/schema.js';
import { hash } from '../src/modules/cards/domain.js';
import { cardholderNameSchema, issueRequestBody, issueRequestHash, nextProfileUpdatedAt, productCatalog, productNetwork } from '../src/modules/cards/products.js';
import { saveProfile } from '../src/modules/cards/profile.js';
import { issueCard } from '../src/modules/cards/service.js';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope = 'izipay:sandbox:unit-test';
const oldTime = new Date('2026-10-06T19:00:00.000Z');
const newTime = new Date('2026-10-06T20:00:00.000Z');
const profile = { userId, emailEnc: 'saved-email', cardholderNameEnc: 'saved-name', createdAt: oldTime, updatedAt: newTime };
const input = { product: 'visa' as const, network: 'tron' as const, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedUserId: userId };
const operation = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', cardId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'issue', status: 'created', createdAt: oldTime, updatedAt: oldTime,
  providerPaymentId: null, invoiceAddress: null, invoiceUrl: null, error: null };
function selection(rows: unknown[]) {
  const chain = { from: (_table: unknown) => chain, where: (_condition: unknown) => chain, for: (_lock: string) => chain, limit: (_count: number) => chain,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
  return chain;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.selections.length = 0;
  state.writes.length = 0;
  state.plaintext.clear();
  state.plaintext.set('saved-email', 'saved@example.com');
  state.plaintext.set('saved-name', 'Saved Name');
  state.encrypt.mockImplementation((plain: string) => { const cipher = `encrypted-${state.plaintext.size}`; state.plaintext.set(cipher, plain); return cipher; });
  state.decrypt.mockImplementation((cipher: string) => state.plaintext.get(cipher));
  state.select.mockImplementation(() => selection(state.selections.shift() ?? []));
  state.insert.mockImplementation((table: unknown) => ({ values: (values: Record<string, unknown>) => {
    state.writes.push({ table, values });
    const result = { ...operation, ...values, ...(table === cardProfiles ? { createdAt: oldTime } : {}) };
    return { returning: async () => [result], onConflictDoUpdate: () => ({ returning: async () => [result] }) };
  } }));
});

describe('card product catalog and private profile contract', () => {
  it('maps all four products to their network and verified price fields without fee constants', () => {
    const catalog = productCatalog({ issuePriceUsd: '10', mastercardIssuePriceUsd: '20' });
    expect(catalog.map(({ id, network, issuePriceUsd }) => [id, network, issuePriceUsd])).toEqual([
      ['visa', 'visa', '10'], ['mastercard_standard', 'mastercard', '10'], ['visa_us', 'visa', '10'], ['mastercard', 'mastercard', '20'],
    ]);
    for (const product of catalog) {
      expect(productNetwork(product.id)).toBe(product.network);
      expect(product.currency).toBe('USD');
      expect(product.description.length).toBeGreaterThan(0);
    }
    expect(productCatalog(null).every((product) => product.issuePriceUsd === null)).toBe(true);
  });
  it('trims optional names, permits explicit clearing, and rejects overlong names', () => {
    expect(cardholderNameSchema.parse('  Alice Example  ')).toBe('Alice Example');
    expect(cardholderNameSchema.parse(undefined)).toBeUndefined();
    expect(cardholderNameSchema.parse(null)).toBeNull();
    expect(cardholderNameSchema.parse('   ')).toBeNull();
    expect(() => cardholderNameSchema.parse('x'.repeat(101))).toThrow();
    expect(cardholderNameSchema.parse(' ' + 'x'.repeat(100) + ' ')).toHaveLength(100);
  });
  it('advances profile versions even for concurrent saves in the same millisecond or a clock rollback', () => {
    const first = nextProfileUpdatedAt(oldTime, oldTime);
    expect(first.getTime()).toBe(oldTime.getTime() + 1);
    expect(nextProfileUpdatedAt(first, oldTime).getTime()).toBe(oldTime.getTime() + 2);
  });
  it('preserves legacy no-version issuance hashes and binds explicit profile versions', () => {
    const legacy = hash(JSON.stringify({ providerScope: scope, product: 'visa', network: 'tron' }));
    expect(issueRequestHash(scope, input)).toBe(legacy);
    expect(issueRequestHash(scope, { ...input, profileUpdatedAt: oldTime.toISOString() })).not.toBe(legacy);
    expect(issueRequestHash(scope, { ...input, profileUpdatedAt: oldTime.toISOString() })).not.toBe(issueRequestHash(scope, { ...input, profileUpdatedAt: newTime.toISOString() }));
    expect(issueRequestHash(scope, { ...input, product: 'visa_us' })).not.toBe(legacy);
  });
  it('maps product and optional alias only into the immutable provider body', () => {
    for (const product of ['visa', 'mastercard_standard', 'visa_us', 'mastercard'] as const) {
      const body = JSON.parse(issueRequestBody({ email: 'saved@example.com', cardholderName: 'Saved Name', cardId: operation.cardId, product, network: 'bsc' }));
      expect(body).toMatchObject({ card_type: product, cardholder_alias: 'Saved Name', pay_currency: 'usdtbsc' });
    }
    const absent = JSON.parse(issueRequestBody({ email: 'saved@example.com', cardholderName: null, cardId: operation.cardId, product: 'visa', network: 'tron' }));
    expect(absent).not.toHaveProperty('cardholder_alias');
  });
});

describe('profile storage and immutable issuance recovery', () => {
  it('preserves the encrypted name when a legacy profile PATCH omits it', async () => {
    state.selections.push([{ id: userId }], [profile]);
    const result = await saveProfile(userId, { email: 'updated@example.com', expectedUserId: userId });
    expect(state.writes[0].values.cardholderNameEnc).toBe('saved-name');
    expect(result).toMatchObject({ email: 'updated@example.com', cardholderName: 'Saved Name' });
    expect(new Date(result.updatedAt).getTime()).toBeGreaterThan(profile.updatedAt.getTime());
  });
  it.each([null, '   '])('clears the private name explicitly with %j', async (cardholderName) => {
    state.selections.push([{ id: userId }], [profile]);
    const result = await saveProfile(userId, { email: 'saved@example.com', expectedUserId: userId, cardholderName });
    expect(state.writes[0].values.cardholderNameEnc).toBeNull();
    expect(result.cardholderName).toBeNull();
  });
  it('encrypts a normalized name and copies that private value into the operation snapshot', async () => {
    state.selections.push([{ id: userId }], [profile]);
    await saveProfile(userId, { email: 'saved@example.com', expectedUserId: userId, cardholderName: '  Alice Example  ' });
    const stored = state.writes[0].values;
    expect(state.encrypt).toHaveBeenCalledWith('Alice Example', `profile-name:${userId}`);
    expect(JSON.stringify(stored)).not.toContain('Alice Example');
    state.selections.push([{ id: userId }], [], [{ ...profile, ...stored }], []);
    await issueCard(userId, { ...input, product: 'mastercard', profileUpdatedAt: (stored.updatedAt as Date).toISOString() });
    const op = state.writes.find(({ table }) => table === cardOperations)!;
    expect(JSON.parse(state.plaintext.get(op.values.requestEnc as string)!)).toMatchObject({ card_type: 'mastercard', cardholder_alias: 'Alice Example', cardholder_email: 'saved@example.com' });
    expect(JSON.stringify(op.values)).not.toMatch(/Alice Example|saved@example.com/);
  });
  it('rejects a new operation against a changed profile before inserting or encrypting any intent', async () => {
    state.selections.push([{ id: userId }], [], [profile]);
    await expect(issueCard(userId, { ...input, profileUpdatedAt: oldTime.toISOString() })).rejects.toMatchObject({ code: 'CARD_PROFILE_CHANGED', status: 409 });
    expect(state.insert).not.toHaveBeenCalled();
    expect(state.encrypt).not.toHaveBeenCalled();
  });
  it('recovers a historical duplicate before loading the now-changed profile', async () => {
    const request = { ...input, profileUpdatedAt: oldTime.toISOString() };
    state.selections.push([{ id: userId }], [{ ...operation, requestHash: issueRequestHash(scope, request) }], [profile]);
    expect(await issueCard(userId, request)).toMatchObject({ id: operation.id });
    expect(state.select).toHaveBeenCalledTimes(2);
    expect(state.insert).not.toHaveBeenCalled();
    expect(state.encrypt).not.toHaveBeenCalled();
  });
  it.each([{ product: 'mastercard' as const }, { profileUpdatedAt: newTime.toISOString() }])('conflicts when a repeated request changes its product or bound profile version: %j', async (change) => {
    state.selections.push([{ id: userId }], [{ ...operation, requestHash: issueRequestHash(scope, input) }]);
    await expect(issueCard(userId, { ...input, ...change })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(state.insert).not.toHaveBeenCalled();
  });
});
