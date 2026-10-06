import { getTableColumns, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { transaction: vi.fn(), select: vi.fn(), update: vi.fn(), insert: vi.fn() }, topup: vi.fn(),
}));
vi.mock('../src/db/client.js', () => ({ db: mocks.db }));
vi.mock('../src/config.js', () => ({ config: { IZIPAY_MODE: 'sandbox' } }));
vi.mock('../src/lib/redis.js', () => ({ redis: {} }));
vi.mock('../src/modules/cards/provider.js', () => ({ provider: { topup: mocks.topup }, ProviderError: class extends Error {}, providerRedisPrefix: 'test' }));
vi.mock('../src/modules/cards/settings.js', () => ({
  providerScope: 'test', cardsEnabled: () => true, decryptCardData: () => '{}', encryptCardData: vi.fn(), requireCards: vi.fn(), unavailable: vi.fn(),
}));
import { cardOperations, cards, cardWebhookEvents, kv, type Card, type CardOperation } from '../src/db/schema.js';
import { sanitizeEvent } from '../src/modules/cards/domain.js';
import { processOneEvent, submitOne } from '../src/modules/cards/reconcile.js';

type Row = Record<string, unknown>;
const dialect = new PgDialect();
const now = new Date('2026-10-06T21:00:00Z');
const past = new Date(now.getTime() - 1000);
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cardId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tables = new Map<PgTable, Row[]>();
const queryErrors: unknown[] = [];
let card: Card;
let operation: CardOperation;
let event: typeof cardWebhookEvents.$inferSelect;

// Evaluate the small SQL predicate subset used by these paths rather than handing
// preselected rows to the matcher. Removing a scope/card/kind/ID filter must change
// the selected rows, so the negative correlation cases exercise the real queries.
function matching(table: PgTable, condition: SQL): Row[] {
  try {
    const { sql, params } = dialect.sqlToQuery(condition);
    const tokens = sql.match(/"[^"]+"\."[^"]+"|\$\d+|<=|>=|<>|!=|[=<>(),]|\b(?:and|or|in|is|not|null)\b/g) ?? [];
    const fields = new Map(Object.entries(getTableColumns(table)).map(([field, column]) => [column.name, field]));
    return (tables.get(table) ?? []).filter((row) => {
      let at = 0;
      const take = (token: string) => { if (tokens[at++] !== token) throw new Error(`Unexpected SQL predicate: ${sql}`); };
      const value = (): unknown => {
        const token = tokens[at++];
        const raw = token.startsWith('$') ? params[Number(token.slice(1)) - 1] : row[fields.get(token.split('"')[3])!];
        return raw instanceof Date ? raw.toISOString() : raw;
      };
      const atom = (): boolean => {
        if (tokens[at] === '(') { at++; const result = disjunction(); take(')'); return result; }
        const left = value(), operator = tokens[at++];
        if (operator === 'in') {
          take('('); const choices = [value()];
          while (tokens[at] === ',') { at++; choices.push(value()); }
          take(')'); return choices.includes(left);
        }
        if (operator === 'is') {
          const negate = tokens[at] === 'not'; if (negate) at++;
          take('null'); return negate ? left !== null : left === null;
        }
        const right = value();
        if (left === null || right === null) return false;
        if (operator === '=') return left === right;
        if (operator === '<>' || operator === '!=') return left !== right;
        if (operator === '<') return (left as string) < (right as string);
        if (operator === '>') return (left as string) > (right as string);
        throw new Error(`Unsupported SQL operator ${operator}`);
      };
      const conjunction = (): boolean => { let result = atom(); while (tokens[at] === 'and') { at++; const next = atom(); result = result && next; } return result; };
      const disjunction = (): boolean => { let result = conjunction(); while (tokens[at] === 'or') { at++; const next = conjunction(); result = result || next; } return result; };
      const result = disjunction();
      if (at !== tokens.length) throw new Error(`Unconsumed SQL predicate: ${sql}`);
      return result;
    });
  } catch (error) { queryErrors.push(error); throw error; }
}
function selection() {
  let table: PgTable, condition: SQL, count = Infinity;
  const chain = { from: (value: PgTable) => { table = value; return chain; }, where: (value: SQL) => { condition = value; return chain; },
    orderBy: () => chain, for: () => chain, limit: (value: number) => { count = value; return chain; },
    then: (resolve: (rows: Row[]) => unknown) => Promise.resolve(matching(table, condition).slice(0, count).map((row) => ({ ...row }))).then(resolve) };
  return chain;
}
function callback(payload: Row) {
  event.payload = { card_id: card.providerCardId, ...payload };
}
function expectUnmatched() {
  expect(event.status).toBe('unmatched');
  expect(event.operationId).toBeNull();
  expect(event.processedAt).toBeNull();
  expect(event.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
  expect((tables.get(cardOperations) ?? []).every((row) => row.status !== 'completed')).toBe(true);
  expect(card.balanceUsd).toBe('10');
  expect(tables.get(kv)).toEqual([]);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); tables.clear(); queryErrors.length = 0;
  card = { id: cardId, userId, providerScope: 'test', providerCardId: 'provider_card', clientCardRef: cardId, product: 'mastercard', currency: 'USD',
    issueStatus: 'issued', providerIssueStatus: 'issued', last4: '1234', isFrozen: false, balanceUsd: '10', pendingTopupUsd: '0', balanceSource: 'provider',
    balanceAsOf: past, issuedAt: past, nextSyncAt: past, syncLeaseUntil: null, syncToken: null, historySyncedAt: past, createdAt: past, updatedAt: past };
  operation = { id: operationId, userId, cardId, providerScope: 'test', kind: 'topup', status: 'processing', requestId: operationId,
    providerIdempotencyKey: 'key', requestHash: 'hash', requestEnc: 'encrypted', providerPaymentId: 'payment_one', providerTopupId: 'topup_one', providerTransactionId: 'SBX-one',
    amountUsd: '5', amountOnCardUsd: null, network: 'bsc', payCurrency: 'usdtbsc', invoiceUrl: null, invoiceAddress: null, invoiceAmount: null, invoiceExpiresAt: null,
    leaseUntil: null, leaseToken: null, attempts: 1, nextAttemptAt: past, submittedAt: past, error: null, createdAt: past, updatedAt: past };
  event = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', providerScope: 'test', providerEventId: 'event_one', eventType: 'topup.completed', eventAt: past,
    payloadHash: 'hash', payload: {}, cardId: null, operationId: null, status: 'pending', attempts: 0, nextAttemptAt: past, lastError: null, receivedAt: past, processedAt: null };
  tables.set(cards, [card]); tables.set(cardOperations, [operation]); tables.set(cardWebhookEvents, [event]); tables.set(kv, []);
  mocks.db.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(mocks.db));
  mocks.db.select.mockImplementation(selection);
  mocks.db.update.mockImplementation((table: PgTable) => ({ set: (values: Row) => ({ where: (condition: SQL) => {
    const rows = matching(table, condition);
    rows.forEach((row) => Object.assign(row, values));
    return { returning: async () => rows.map((row) => ({ ...row })) };
  } }) }));
  mocks.db.insert.mockImplementation((table: PgTable) => ({ values: (values: Row) => ({ onConflictDoUpdate: async () => {
    const rows = tables.get(table)!;
    const old = rows.find((row) => row.key === values.key);
    if (old) Object.assign(old, values); else rows.push(values);
  } }) }));
  mocks.topup.mockResolvedValue({ card_id: card.providerCardId, topup_id: 'topup_new', transaction_id: 'SBX-new',
    status: 'credited', funded_from: 'balance', sandbox: true, amount_usd: '5', amount_on_card: '4.51' });
});
afterEach(() => { vi.useRealTimers(); expect(queryErrors).toEqual([]); });

describe('top-up response transaction correlation', () => {
  function created() {
    Object.assign(operation, { status: 'created', attempts: 0, submittedAt: null, providerPaymentId: null, providerTopupId: null, providerTransactionId: null });
  }
  it('persists the transaction ID from the single accepted dispatch and links its transaction-only callback', async () => {
    created();
    await submitOne();
    expect(operation).toMatchObject({ status: 'completed', providerTransactionId: 'SBX-new', providerTopupId: 'topup_new', attempts: 1 });
    callback({ transaction_id: 'SBX-new' });
    await processOneEvent();
    expect(event).toMatchObject({ status: 'processed', cardId, operationId });
    expect(await submitOne()).toBe(false);
    expect(mocks.topup).toHaveBeenCalledTimes(1);
    expect(card.balanceUsd).toBe('10');
  });
  it('retains the transaction ID on a correlated invalid-invoice response for later callback reconciliation', async () => {
    created();
    mocks.topup.mockResolvedValue({ card_id: card.providerCardId, topup_id: 'topup_new', transaction_id: 'SBX-new',
      payment: { payment_id: 'payment_new', deposit_address: 'TEST', pay_amount: '5', pay_currency: 'usdttrc20', network: 'trc20' } });
    await submitOne();
    expect(operation).toMatchObject({ status: 'review', providerTransactionId: 'SBX-new', providerTopupId: 'topup_new', invoiceAddress: null });
    callback({ transaction_id: 'SBX-new' });
    await processOneEvent();
    expect(operation.status).toBe('completed');
    expect(event).toMatchObject({ status: 'processed', operationId });
    expect(mocks.topup).toHaveBeenCalledTimes(1);
  });
  it('does not attach a transaction ID from a response for another provider card', async () => {
    created();
    mocks.topup.mockResolvedValue({ card_id: 'foreign_card', topup_id: 'topup_new', transaction_id: 'SBX-new', status: 'credited', funded_from: 'balance', sandbox: true, amount_usd: '5', amount_on_card: '4.51' });
    await submitOne();
    expect(operation).toMatchObject({ status: 'review', providerTransactionId: null, providerTopupId: null });
    callback({ transaction_id: 'SBX-new' });
    await processOneEvent();
    expectUnmatched();
    expect(mocks.topup).toHaveBeenCalledTimes(1);
  });
});

describe('durable top-up callback matching', () => {
  it.each([{ transaction_id: 'SBX-one' }, { payment_id: 'payment_one' }, { topup_id: 'topup_one' },
    { payment_id: 'payment_one', topup_id: 'topup_one', transaction_id: 'SBX-one' }])('matches the exact operation using saved identifiers: %j', async (ids) => {
    callback(ids);
    await processOneEvent();
    expect(operation.status).toBe('completed');
    expect(event).toMatchObject({ status: 'processed', cardId, operationId });
    expect(card.historySyncedAt).toBeNull();
    expect(card.balanceUsd).toBe('10');
    expect(mocks.topup).not.toHaveBeenCalled();
  });
  it.each([{ transaction_id: 'SBX-unknown' }, {}, { transaction_id: '../invalid' },
    { transaction_id: 'SBX-one', topup_id: 'topup_unknown' }, { payment_id: 'payment_one', transaction_id: 'SBX-unknown' }])('retains unknown or contradictory identifiers without completing an operation: %j', async (ids) => {
    callback(ids);
    await processOneEvent();
    expectUnmatched();
    expect(mocks.topup).not.toHaveBeenCalled();
  });
  it('does not choose between two operations identified by conflicting callback fields', async () => {
    const other = { ...operation, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', providerPaymentId: 'payment_two', providerTopupId: 'topup_two', providerTransactionId: 'SBX-two' };
    tables.get(cardOperations)!.push(other);
    callback({ payment_id: 'payment_one', transaction_id: 'SBX-two' });
    await processOneEvent();
    expectUnmatched();
  });
  it.each([{ cardId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, { kind: 'issue' }])('excludes an otherwise matching operation outside the exact card/kind: %j', async (change) => {
    Object.assign(operation, change);
    callback({ transaction_id: 'SBX-one' });
    await processOneEvent();
    expectUnmatched();
  });
  it('isolates provider scopes even when they reuse the same upstream card and transaction IDs', async () => {
    const foreignId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    tables.get(cards)!.push({ ...card, id: foreignId, clientCardRef: foreignId, providerScope: 'foreign-scope' });
    // Composite FKs bind an operation to its card's scope in the actual database.
    Object.assign(operation, { cardId: foreignId, providerScope: 'foreign-scope' });
    callback({ transaction_id: 'SBX-one' });
    await processOneEvent();
    expectUnmatched();
  });
  it('does not match the transaction ID without a matching provider card', async () => {
    callback({ card_id: 'foreign_card', transaction_id: 'SBX-one' });
    await processOneEvent();
    expectUnmatched();
  });
  it('does not guess the transaction mapping for a historical operation lacking its saved ID', async () => {
    operation.providerTransactionId = null;
    callback({ transaction_id: 'SBX-one' });
    await processOneEvent();
    expectUnmatched();
    expect(operation.providerTransactionId).toBeNull();
  });
  it.each([{ payment_id: 'payment_one' }, { topup_id: 'topup_one' }])('learns a missing transaction ID only through an exact saved anchor: %j', async (anchor) => {
    operation.providerTransactionId = null;
    callback({ ...anchor, transaction_id: 'SBX-new' });
    await processOneEvent();
    expect(operation).toMatchObject({ status: 'completed', providerTransactionId: 'SBX-new' });
    expect(event).toMatchObject({ status: 'processed', cardId, operationId });
    expect(mocks.topup).not.toHaveBeenCalled();
  });
  it('does not learn a transaction ID when its claimed anchor is unknown', async () => {
    operation.providerTransactionId = null;
    callback({ payment_id: 'payment_unknown', transaction_id: 'SBX-new' });
    await processOneEvent();
    expectUnmatched();
    expect(operation.providerTransactionId).toBeNull();
  });
  it('reconciles an early unmatched event only after the exact response mapping is saved', async () => {
    operation.providerTransactionId = null;
    callback({ transaction_id: 'SBX-one' });
    await processOneEvent();
    expectUnmatched();
    operation.providerTransactionId = 'SBX-one';
    vi.advanceTimersByTime(15_001);
    await processOneEvent();
    expect(event).toMatchObject({ status: 'processed', cardId, operationId });
    expect(operation.status).toBe('completed');
    expect(mocks.topup).not.toHaveBeenCalled();
  });
  it('preserves the genuine transaction-only callback identifier while stripping unrelated private payload fields', () => {
    const sanitized = sanitizeEvent({ id: 'event_one', type: 'topup.completed', data: { card_id: 'provider_card', transaction_id: 'SBX-one', cvv: '123', cardholder_email: 'private@example.com' } });
    expect(sanitized.payload).toEqual({ card_id: 'provider_card', transaction_id: 'SBX-one' });
  });
});
