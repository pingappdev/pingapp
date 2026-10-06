import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { transaction: vi.fn(), select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  card: vi.fn(), topup: vi.fn(), pricing: vi.fn(), enabled: vi.fn(),
}));
vi.mock('../src/db/client.js', () => ({ db: mocks.db }));
vi.mock('../src/config.js', () => ({ config: { IZIPAY_MODE: 'sandbox' } }));
vi.mock('../src/lib/redis.js', () => ({ redis: { set: vi.fn() } }));
vi.mock('../src/modules/cards/provider.js', () => ({
  provider: { card: mocks.card, topup: mocks.topup, pricing: mocks.pricing }, ProviderError: class extends Error {}, providerRedisPrefix: 'test',
}));
vi.mock('../src/modules/cards/settings.js', () => ({
  providerScope: 'test', cardsEnabled: mocks.enabled, decryptCardData: () => '{}',
  encryptCardData: vi.fn(), requireCards: vi.fn(), unavailable: vi.fn(),
}));
import { cardOperations, cards, kv, type Card, type CardOperation } from '../src/db/schema.js';
import type { DbTransaction } from '../src/db/tx.js';
import { refreshPricing, submitOne, syncOneCard } from '../src/modules/cards/reconcile.js';
import { balanceRefreshKey, requestBalanceRefresh, scheduleStaleBalanceReads, shouldScheduleBalanceRead } from '../src/modules/cards/refresh.js';
import { getCard, listCards, pricingKey } from '../src/modules/cards/service.js';

const dialect = new PgDialect();
const start = new Date('2026-10-06T20:00:00.000Z');
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let card: Card;
let operation: CardOperation | null;
const saved = new Map<string, { value: unknown; updatedAt: Date }>();
const writes: Record<string, unknown>[] = [];

// A small stateful database double exercises reconciliation across asynchronous provider
// reads. It honors the owner, due-time and token conditions used by these code paths.
function query(condition: SQL) { return dialect.sqlToQuery(condition); }
function selections(table: unknown, condition: SQL) {
  const { sql, params } = query(condition);
  if (table === cards) {
    if (sql.includes('"user_id"') && (!params.includes(userId) || !params.includes('test'))) return [];
    if (sql.includes('"next_sync_at" <') && (card.nextSyncAt >= new Date() || card.syncLeaseUntil && card.syncLeaseUntil >= new Date())) return [];
    return [{ ...card }];
  }
  if (table === kv) { const row = saved.get(params[0] as string); return row ? [{ ...row }] : []; }
  if (table === cardOperations) {
    if (!operation || params.includes('issue') || params.includes('created') && operation.status !== 'created') return [];
    return [{ ...operation }];
  }
  throw new Error('Unexpected table');
}
function selection() {
  let table: unknown, condition: SQL;
  const chain = { from: (value: unknown) => { table = value; return chain; }, where: (value: SQL) => { condition = value; return chain; },
    orderBy: () => chain, for: () => chain, limit: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(selections(table, condition)).then(resolve) };
  return chain;
}
function fixtureTopup(): CardOperation {
  return { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cardId: card.id, userId, providerScope: 'test', kind: 'topup', status: 'created',
    amountUsd: '25', amountOnCardUsd: null, requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', providerIdempotencyKey: 'key', requestHash: 'hash', requestEnc: 'ciphertext',
    providerPaymentId: null, providerTopupId: null, network: 'bsc', payCurrency: 'usdtbsc', invoiceUrl: null, invoiceAddress: null, invoiceAmount: null, invoiceExpiresAt: null,
    leaseUntil: null, leaseToken: null, attempts: 0, nextAttemptAt: new Date(start.getTime() - 1000), submittedAt: null, error: null, createdAt: start, updatedAt: start };
}
const snapshot = (balance: string | null) => ({ card_id: 'provider_card', issue_status: 'issued', card: {
  ...(balance === null ? {} : { balance }), pending_topup: '0', last4: '1234', number: '4111111111111234', cvv: '123',
} });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(start); vi.clearAllMocks();
  saved.clear(); writes.length = 0; operation = null;
  card = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', userId, providerScope: 'test', providerCardId: 'provider_card', clientCardRef: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    product: 'visa', currency: 'USD', issueStatus: 'issued', providerIssueStatus: 'issued', last4: '1234', isFrozen: false, balanceUsd: '10', pendingTopupUsd: '0', balanceSource: 'provider',
    balanceAsOf: new Date(start.getTime() - 60_000), issuedAt: start, nextSyncAt: new Date(start.getTime() - 1000), syncLeaseUntil: null, syncToken: null,
    historySyncedAt: start, createdAt: start, updatedAt: start };
  mocks.enabled.mockReturnValue(true);
  mocks.db.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(mocks.db));
  mocks.db.select.mockImplementation(selection);
  mocks.db.update.mockImplementation((table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: (condition: SQL) => {
    const { sql, params } = query(condition);
    if (table === cards && sql.includes('"sync_token" =') && !params.includes(card.syncToken)) return { returning: async () => [] };
    writes.push(values);
    if (table === cards) Object.assign(card, values);
    else if (table === cardOperations) Object.assign(operation!, values);
    else throw new Error('Unexpected update');
    return { returning: async () => [{ ...(table === cards ? card : operation) }] };
  } }) }));
  mocks.db.insert.mockImplementation((table: unknown) => ({ values: ({ key, value }: { key: string; value: unknown }) => ({ onConflictDoUpdate: async () => {
    if (table !== kv) throw new Error('Unexpected insert');
    saved.set(key, { value, updatedAt: new Date() });
  } }) }));
  mocks.db.delete.mockImplementation((table: unknown) => ({ where: async (condition: SQL) => {
    if (table !== kv) throw new Error('Unexpected delete');
    saved.delete(query(condition).params[0] as string);
  } }));
  mocks.card.mockResolvedValue(snapshot('32.55'));
  mocks.topup.mockResolvedValue({ card_id: card.providerCardId, topup_id: 'topup_one', status: 'credited', funded_from: 'balance', sandbox: true, amount_usd: '25', amount_on_card: '22.55', balance_usd: '999' });
});
afterEach(() => { vi.useRealTimers(); });

describe('authoritative balance refreshes', () => {
  it('uses a durable live request and applies only the returned absolute snapshot', async () => {
    await requestBalanceRefresh(mocks.db as unknown as DbTransaction, card.id);
    vi.advanceTimersByTime(1);
    await syncOneCard();
    expect(mocks.card).toHaveBeenCalledWith('provider_card', true);
    expect(card.balanceUsd).toBe('32.55');
    expect(card.balanceAsOf).toEqual(new Date());
    expect(saved.has(balanceRefreshKey(card.id))).toBe(false);
    expect(JSON.stringify(writes)).not.toMatch(/4111111111111234|cvv/);
  });
  it('fences an older in-flight read when a top-up completes, retaining its immediate live refresh', async () => {
    let resolveOld!: (value: unknown) => void;
    let started!: () => void;
    const startedRead = new Promise<void>((resolve) => { started = resolve; });
    mocks.card.mockImplementationOnce(() => { started(); return new Promise((resolve) => { resolveOld = resolve; }); });
    const oldRead = syncOneCard();
    await startedRead;
    expect(card.syncToken).not.toBeNull();
    vi.advanceTimersByTime(1000);
    operation = fixtureTopup();
    await submitOne();
    const dueAt = card.nextSyncAt;
    expect(operation.status).toBe('completed');
    expect(card.syncToken).toBeNull();
    resolveOld(snapshot('1'));
    await oldRead;
    expect(card.balanceUsd).toBe('10');
    expect(card.nextSyncAt).toEqual(dueAt);
    expect(saved.get(balanceRefreshKey(card.id))?.value).toEqual({ live: true });
    vi.advanceTimersByTime(1);
    await syncOneCard();
    expect(mocks.card).toHaveBeenLastCalledWith('provider_card', true);
    expect(card.balanceUsd).toBe('32.55');
    expect(mocks.topup).toHaveBeenCalledTimes(1);
  });
  it('makes history and a live card read due on completion without inferring a balance delta or replaying the top-up', async () => {
    operation = fixtureTopup();
    await submitOne();
    expect(operation.status).toBe('completed');
    expect(card.balanceUsd).toBe('10'); // Ignores both mutation balance_usd and amount_on_card.
    expect(card.historySyncedAt).toBeNull();
    expect(saved.get(`cards:history-offset:${card.id}`)?.value).toMatchObject({ offset: 0 });
    expect(saved.get(balanceRefreshKey(card.id))?.value).toEqual({ live: true });
    expect(await submitOne()).toBe(false);
    expect(mocks.topup).toHaveBeenCalledTimes(1);
  });
  it('retains the live intent and cooldown after a failed read despite repeated browser polls', async () => {
    await requestBalanceRefresh(mocks.db as unknown as DbTransaction, card.id);
    vi.advanceTimersByTime(1);
    mocks.card.mockRejectedValueOnce(new Error('budget exhausted'));
    await syncOneCard();
    const retryAt = card.nextSyncAt;
    expect(retryAt.getTime()).toBe(Date.now() + 60_000);
    await scheduleStaleBalanceReads(userId, [card.id]);
    await syncOneCard();
    expect(card.nextSyncAt).toEqual(retryAt);
    expect(mocks.card).toHaveBeenCalledTimes(1);
    expect(saved.get(balanceRefreshKey(card.id))?.value).toEqual({ live: true });
    vi.advanceTimersByTime(60_001);
    await syncOneCard();
    expect(mocks.card).toHaveBeenLastCalledWith('provider_card', true);
    expect(card.balanceUsd).toBe('32.55');
  });
  it('does not fulfill a live refresh or mark the balance fresh when the provider omits its balance', async () => {
    await requestBalanceRefresh(mocks.db as unknown as DbTransaction, card.id);
    vi.advanceTimersByTime(1);
    mocks.card.mockResolvedValueOnce(snapshot(null));
    const asOf = card.balanceAsOf;
    await syncOneCard();
    expect(card.balanceUsd).toBe('10');
    expect(card.balanceAsOf).toEqual(asOf);
    expect(saved.has(balanceRefreshKey(card.id))).toBe(true);
    expect(shouldScheduleBalanceRead(card)).toBe(false);
  });
});

describe('bounded browser read scheduling', () => {
  it.each([listCards, (owner: string) => getCard(owner, card.id)])('schedules stale list/detail snapshots once, without inline provider requests', async (read) => {
    card.nextSyncAt = new Date(start.getTime() + 120_000);
    await read(userId);
    const dueAt = card.nextSyncAt;
    await read(userId);
    expect(card.nextSyncAt).toEqual(dueAt);
    expect(saved.get(balanceRefreshKey(card.id))?.value).toEqual({ live: true });
    expect(mocks.card).not.toHaveBeenCalled();
    expect(mocks.db.insert).toHaveBeenCalledTimes(1);
  });
  it('preserves a healthy in-flight read and waits for a fresh snapshot to age', async () => {
    card.nextSyncAt = new Date(start.getTime() + 120_000);
    card.syncToken = 'lease'; card.syncLeaseUntil = new Date(start.getTime() + 60_000);
    await scheduleStaleBalanceReads(userId, [card.id]);
    expect(card.syncToken).toBe('lease');
    card.syncToken = null; card.syncLeaseUntil = null; card.balanceAsOf = start;
    await scheduleStaleBalanceReads(userId, [card.id]);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_001);
    await scheduleStaleBalanceReads(userId, [card.id]);
    expect(mocks.db.insert).toHaveBeenCalledTimes(1);
  });
  it('does not schedule a foreign card or a disabled provider', async () => {
    card.nextSyncAt = new Date(start.getTime() + 120_000);
    await scheduleStaleBalanceReads('other-owner', [card.id]);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    mocks.enabled.mockReturnValue(false);
    await scheduleStaleBalanceReads(userId, [card.id]);
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });
});

describe('provider pricing refresh', () => {
  it('refreshes an old-format cache and preserves the distinct Visa US price', async () => {
    saved.set(pricingKey, { value: { issuePriceUsd: '10', mastercardIssuePriceUsd: '20' }, updatedAt: start });
    mocks.pricing.mockResolvedValue({ pricing: { visa_issue_usd: '10', visa_us_issue_usd: '12', mastercard_issue_usd: '20' } });
    await refreshPricing();
    expect(saved.get(pricingKey)?.value).toEqual({ issuePriceUsd: '10', visaUsIssuePriceUsd: '12', mastercardIssuePriceUsd: '20' });
    await refreshPricing();
    expect(mocks.pricing).toHaveBeenCalledTimes(1);
  });
  it('uses Visa pricing only when the dedicated field is absent', async () => {
    mocks.pricing.mockResolvedValue({ pricing: { visa_issue_usd: '10', mastercard_issue_usd: '20' } });
    await refreshPricing();
    expect(saved.get(pricingKey)?.value).toMatchObject({ visaUsIssuePriceUsd: '10' });
  });
});
