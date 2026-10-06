import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { cardOperations, cards, cardTransactions, cardWebhookEvents, kv, type Card, type CardOperation } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { redis } from '../../lib/redis.js';
import { advanceStatus, decimal, identifier, issueOperationStatus, normalizeCard, normalizeInvoice, normalizeTransaction, record, transactionUpdate, type CardNetwork, type OperationStatus } from './domain.js';
import { provider, ProviderError, providerRedisPrefix } from './provider.js';
import { pricingKey } from './service.js';
import { cardsEnabled, decryptCardData, providerScope } from './settings.js';

const REVIEW = 'We are checking the outcome of this request. Do not make another payment. Contact support if it does not update.';
const FUNDING_REVIEW = 'The provider used an unexpected funding source. Contact support before continuing.';
const REJECTED = 'The card provider could not accept this request. Please check the details or contact support.';
const later = (ms: number) => new Date(Date.now() + ms);
async function lockCard(tx: DbTransaction, id: string) {
  const [card] = await tx.select().from(cards).where(eq(cards.id, id)).for('update');
  return card;
}
async function lockOperation(tx: DbTransaction, id: string) {
  const [op] = await tx.select().from(cardOperations).where(eq(cardOperations.id, id)).for('update');
  return op;
}
async function setOperation(tx: DbTransaction, op: CardOperation, status: OperationStatus, extra: Partial<typeof cardOperations.$inferInsert> = {}) {
  const next = op.error === FUNDING_REVIEW ? 'review' : advanceStatus(op.status, status);
  await tx.update(cardOperations).set({ ...extra, status: next, updatedAt: new Date(),
    error: next === 'completed' ? null : next === 'review' ? extra.error ?? op.error ?? REVIEW : extra.error === undefined ? op.error : extra.error,
  }).where(eq(cardOperations.id, op.id));
  if (op.kind === 'topup' && next === 'completed' && op.status !== 'completed') {
    // Both accepted HTTP credits and matched completion callbacks use this transition.
    // Start from the newest page even when an older pagination cycle is in progress.
    await requestHistoryRefresh(tx, op.cardId);
  }
}

export async function requestHistoryRefresh(tx: DbTransaction, cardId: string) {
  await tx.update(cards).set({ historySyncedAt: null, nextSyncAt: new Date() }).where(eq(cards.id, cardId));
  const key = `cards:history-offset:${cardId}`;
  const value = { offset: 0, generation: randomUUID() };
  await tx.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

export async function submitOne(): Promise<boolean> {
  const op = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(cardOperations).where(and(eq(cardOperations.providerScope, providerScope), eq(cardOperations.status, 'created'), lt(cardOperations.nextAttemptAt, new Date())))
      .orderBy(asc(cardOperations.createdAt)).for('update', { skipLocked: true }).limit(1);
    if (!row) return null;
    const [claimed] = await tx.update(cardOperations).set({ status: 'submitting', leaseUntil: later(60_000), leaseToken: randomUUID(), attempts: row.attempts + 1, submittedAt: new Date(), updatedAt: new Date() }).where(eq(cardOperations.id, row.id)).returning();
    return claimed;
  });
  if (!op) return false;
  let result: unknown;
  try {
    const rawBody = decryptCardData(op.requestEnc, `operation:${op.id}`);
    if (op.kind === 'issue') result = await provider.issue(rawBody, op.providerIdempotencyKey);
    else {
      const [card] = await db.select().from(cards).where(eq(cards.id, op.cardId));
      if (!card?.providerCardId || card.issueStatus !== 'issued') throw new ProviderError('not_sent', 'invalid_response');
      result = await provider.topup(card.providerCardId, rawBody, op.providerIdempotencyKey);
    }
  } catch (error) {
    await db.transaction(async (tx) => {
      const card = await lockCard(tx, op.cardId), current = await lockOperation(tx, op.id);
      if (current.leaseToken !== op.leaseToken) return;
      const notSent = error instanceof ProviderError && error.outcome === 'not_sent';
      const rejected = error instanceof ProviderError && error.outcome === 'rejected';
      const status = notSent ? 'created' : rejected ? 'failed' : 'review';
      await setOperation(tx, current, status, { leaseUntil: null, leaseToken: null, nextAttemptAt: later(notSent ? 60_000 : 300_000),
        ...(notSent ? { submittedAt: null, attempts: Math.max(0, current.attempts - 1) } : {}), error: rejected ? REJECTED : notSent ? null : REVIEW });
      if (op.kind === 'issue' && card.issueStatus !== 'issued') await tx.update(cards).set({ issueStatus: rejected ? 'failed' : notSent ? 'requested' : 'unknown', updatedAt: new Date() }).where(eq(cards.id, card.id));
    });
    return true;
  }
  // Transform upstream values outside persistence. Never write a provider object to the DB.
  try {
    const data = record(result), info = normalizeCard(data);
    const topupId = identifier(data.topup_id);
    const sandboxCredit = op.kind === 'topup' && config.IZIPAY_MODE === 'sandbox' && data.sandbox === true && data.funded_from === 'balance' && data.status === 'credited' && topupId && decimal(data.amount_usd) === decimal(op.amountUsd) && decimal(data.amount_on_card) !== null;
    // This sandbox-only deviation contains no payment instructions to display.
    const balanceFunded = data.funded_from === 'balance';
    const invoice = balanceFunded ? null : normalizeInvoice(data, op.network as CardNetwork);
    await db.transaction(async (tx) => {
      const card = await lockCard(tx, op.cardId), current = await lockOperation(tx, op.id);
      if (current.leaseToken !== op.leaseToken) return;
      if (!info.providerCardId || card.providerCardId && card.providerCardId !== info.providerCardId) throw new Error('Card correlation mismatch');
      if (info.clientCardRef && info.clientCardRef !== card.clientCardRef) throw new Error('Card reference mismatch');
      let status: OperationStatus = op.kind === 'issue' ? issueOperationStatus(info.issueStatus) : sandboxCredit ? 'completed' : 'awaiting_payment';
      if (balanceFunded && !sandboxCredit || op.kind === 'topup' && !sandboxCredit && !invoice?.address && !invoice?.url) status = 'review';
      if (op.kind === 'issue' && status === 'awaiting_payment' && !invoice?.address && !current.invoiceAddress && !invoice?.url && !current.invoiceUrl) status = 'review';
      const extra: Partial<typeof cardOperations.$inferInsert> = { leaseUntil: null, leaseToken: null, nextAttemptAt: later(60_000), error: balanceFunded && !sandboxCredit ? FUNDING_REVIEW : status === 'review' ? REVIEW : null };
      if (topupId) extra.providerTopupId = topupId;
      if (sandboxCredit) extra.amountOnCardUsd = decimal(data.amount_on_card);
      // Duplicate issue responses omit invoices; never erase already persisted instructions.
      if (invoice) {
        if (invoice.paymentId) extra.providerPaymentId = invoice.paymentId;
        if (invoice.address) extra.invoiceAddress = invoice.address;
        if (invoice.amount !== null) extra.invoiceAmount = invoice.amount;
        if (invoice.amountUsd !== null) extra.amountUsd = invoice.amountUsd;
        if (invoice.amountOnCardUsd !== null) extra.amountOnCardUsd = invoice.amountOnCardUsd;
        if (invoice.expiresAt) extra.invoiceExpiresAt = new Date(invoice.expiresAt);
        if (invoice.url) extra.invoiceUrl = invoice.url;
      }
      await setOperation(tx, current, status, extra);
      await tx.update(cards).set({ providerCardId: info.providerCardId,
        ...(op.kind === 'issue' && card.issueStatus !== 'issued' ? { issueStatus: balanceFunded ? 'unknown' : info.issueStatus } : {}),
        nextSyncAt: new Date(), updatedAt: new Date(),
      }).where(eq(cards.id, card.id));
    });
  } catch {
    // Even an invalid invoice can follow an accepted mutation. Retain correlated IDs for support
    // and later callbacks, but never persist its unvalidated address/network/payment instructions.
    try {
      await db.transaction(async (tx) => {
        const card = await lockCard(tx, op.cardId), current = await lockOperation(tx, op.id);
        if (current.leaseToken !== op.leaseToken) return;
        const data = record(result), info = normalizeCard(data);
        const correlated = info.providerCardId && (!card.providerCardId || card.providerCardId === info.providerCardId) &&
          (!info.clientCardRef || info.clientCardRef === card.clientCardRef);
        const paymentId = identifier(record(data.payment).payment_id ?? data.payment_id);
        const topupId = identifier(data.topup_id);
        await setOperation(tx, current, 'review', { leaseToken: null, leaseUntil: null,
          ...(correlated && !current.providerPaymentId && paymentId ? { providerPaymentId: paymentId } : {}),
          ...(correlated && !current.providerTopupId && topupId ? { providerTopupId: topupId } : {}),
        });
        if (correlated) await tx.update(cards).set({ providerCardId: info.providerCardId,
          ...(op.kind === 'issue' && card.issueStatus !== 'issued' ? { issueStatus: 'unknown' } : {}),
          nextSyncAt: new Date(), updatedAt: new Date(),
        }).where(eq(cards.id, card.id));
      });
    } catch {
      // A conflicting provider ID itself needs review; do not attach it to a second owner.
      await db.update(cardOperations).set({ status: 'review', error: REVIEW, leaseUntil: null, leaseToken: null, updatedAt: new Date() })
        .where(and(eq(cardOperations.id, op.id), eq(cardOperations.leaseToken, op.leaseToken!), ne(cardOperations.status, 'completed')));
    }
  }
  return true;
}

export async function recoverExpiredLeases() {
  await db.update(cardOperations).set({ status: 'review', error: REVIEW, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(cardOperations.providerScope, providerScope), eq(cardOperations.status, 'submitting'), lt(cardOperations.leaseUntil, new Date())));
}
async function applyCard(tx: DbTransaction, card: Card, value: unknown, fetchedAt: Date) {
  const info = normalizeCard(value);
  if (!info.providerCardId || info.providerCardId !== card.providerCardId || info.clientCardRef && info.clientCardRef !== card.clientCardRef) throw new Error('Card correlation mismatch');
  const [issue] = await tx.select().from(cardOperations).where(and(eq(cardOperations.cardId, card.id), eq(cardOperations.kind, 'issue'))).for('update');
  const fundingReview = issue?.error === FUNDING_REVIEW;
  const newer = !card.balanceAsOf || fetchedAt >= card.balanceAsOf;
  await tx.update(cards).set({
    issueStatus: fundingReview ? 'unknown' : card.issueStatus === 'issued' ? 'issued' : info.issueStatus,
    providerIssueStatus: info.issueStatus,
    ...(info.last4 ? { last4: info.last4 } : {}), ...(info.isFrozen !== null ? { isFrozen: info.isFrozen } : {}),
    ...(info.issuedAt ? { issuedAt: new Date(info.issuedAt) } : {}),
    ...(newer && info.balanceUsd !== null ? { balanceUsd: info.balanceUsd, balanceAsOf: fetchedAt, balanceSource: info.balanceSource } : {}),
    ...(newer && info.pendingTopupUsd !== null ? { pendingTopupUsd: info.pendingTopupUsd } : {}), updatedAt: new Date(),
  }).where(eq(cards.id, card.id));
  if (issue) {
    const status = issueOperationStatus(info.issueStatus);
    // Details and duplicate responses cannot reconstruct a lost issuance invoice.
    const paymentId = identifier(record(value).payment_id);
    const extra = !issue.providerPaymentId && paymentId ? { providerPaymentId: paymentId } : {};
    await setOperation(tx, issue, status === 'awaiting_payment' && !issue.invoiceAddress && !issue.invoiceUrl ? 'review' : status, extra);
  }
  // A card's absolute balance never establishes which top-up was credited.
}
export async function syncOneCard() {
  const card = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(cards).where(and(eq(cards.providerScope, providerScope), sql`${cards.providerCardId} is not null`, lt(cards.nextSyncAt, new Date()),
      or(isNull(cards.syncLeaseUntil), lt(cards.syncLeaseUntil, new Date())))).orderBy(asc(cards.nextSyncAt)).for('update', { skipLocked: true }).limit(1);
    if (!row) return null;
    const [claimed] = await tx.update(cards).set({ syncLeaseUntil: later(60_000), syncToken: randomUUID(), nextSyncAt: later(120_000) }).where(eq(cards.id, row.id)).returning();
    return claimed;
  });
  if (!card) return;
  const fetchedAt = new Date();
  try {
    const value = await provider.card(card.providerCardId!);
    await db.transaction(async (tx) => {
      const current = await lockCard(tx, card.id);
      if (current.syncToken !== card.syncToken) return;
      await applyCard(tx, current, value, fetchedAt);
      await tx.update(cards).set({ syncLeaseUntil: null, syncToken: null, nextSyncAt: later(current.issueStatus === 'issued' ? 120_000 : 30_000) }).where(eq(cards.id, current.id));
    });
  } catch {
    await db.update(cards).set({ syncLeaseUntil: null, syncToken: null, nextSyncAt: later(60_000) }).where(and(eq(cards.id, card.id), eq(cards.syncToken, card.syncToken!)));
  }
}

// Read-only recovery by the immutable local reference: no automatic mutation replay.
export async function recoverUnmatchedCards() {
  const unknown = await db.select().from(cards).where(and(eq(cards.providerScope, providerScope), isNull(cards.providerCardId), inArray(cards.issueStatus, ['requested', 'unknown']), lt(cards.nextSyncAt, new Date()))).limit(100);
  if (!unknown.length) return;
  const key = `cards:recovery-page:${providerScope}`;
  const [saved] = await db.select().from(kv).where(eq(kv.key, key));
  const page = Math.max(1, Math.min(10000, Number(record(saved?.value).page) || 1));
  const value = record(await provider.cards(page));
  const list = Array.isArray(value.cards) ? value.cards : [];
  for (const item of list) {
    const info = normalizeCard(item);
    const local = unknown.find((row) => row.clientCardRef === info.clientCardRef);
    if (!local || !info.providerCardId) continue;
    await db.transaction(async (tx) => {
      const card = await lockCard(tx, local.id);
      if (card.providerCardId && card.providerCardId !== info.providerCardId) return;
      await tx.update(cards).set({ providerCardId: info.providerCardId, nextSyncAt: new Date(), updatedAt: new Date() }).where(eq(cards.id, card.id));
    });
  }
  const pages = Number(value.total_pages);
  const next = Number.isSafeInteger(pages) && page < pages && list.length ? page + 1 : 1;
  await db.insert(kv).values({ key, value: { page: next } }).onConflictDoUpdate({ target: kv.key, set: { value: { page: next }, updatedAt: new Date() } });
  if (next === 1) await db.update(cards).set({ nextSyncAt: later(300_000) }).where(and(inArray(cards.id, unknown.map((row) => row.id)), isNull(cards.providerCardId)));
}

export async function upsertTransaction(tx: DbTransaction, card: Card, normalized: NonNullable<ReturnType<typeof normalizeTransaction>>, eventAt: Date | null = null) {
  const incoming = { ...normalized, cardId: card.id, providerScope, occurredAt: new Date(normalized.occurredAt),
    sourceUpdatedAt: normalized.sourceUpdatedAt ? new Date(normalized.sourceUpdatedAt) : eventAt, syncedAt: new Date() };
  const [existing] = await tx.select().from(cardTransactions).where(and(eq(cardTransactions.cardId, card.id), eq(cardTransactions.providerTransactionId, normalized.providerTransactionId))).for('update');
  if (!existing) { await tx.insert(cardTransactions).values(incoming); return; }
  const update = transactionUpdate(existing, incoming);
  if (!update) return;
  // Same status may legitimately correct an amount; preserve its last known source ordering.
  await tx.update(cardTransactions).set(update).where(eq(cardTransactions.id, existing.id));
}
export async function syncOneHistory() {
  const [card] = await db.select().from(cards).where(and(eq(cards.providerScope, providerScope), eq(cards.issueStatus, 'issued'), sql`${cards.providerCardId} is not null`,
    or(isNull(cards.historySyncedAt), lt(cards.historySyncedAt, new Date(Date.now() - 300_000))))).orderBy(sql`${cards.historySyncedAt} asc nulls first`, asc(cards.id)).limit(1);
  if (!card) return;
  const key = `cards:history-offset:${card.id}`;
  const [saved] = await db.select().from(kv).where(eq(kv.key, key));
  const savedState = record(saved?.value);
  const offset = Math.max(0, Math.min(1_000_000, Number(savedState.offset) || 0));
  const raw = await provider.transactions(card.providerCardId!, offset), data = record(raw);
  if (data.card_id && data.card_id !== card.providerCardId) throw new Error('History correlation mismatch');
  const list = Array.isArray(data.transactions) ? data.transactions : Array.isArray(raw) ? raw : null;
  if (!list) throw new Error('Invalid history shape');
  const total = Number(record(data.pagination).total);
  const nextOffset = list.length && Number.isSafeInteger(total) && offset + list.length < total ? offset + list.length : 0;
  await db.transaction(async (tx) => {
    const current = await lockCard(tx, card.id);
    for (const item of list) {
      const normalized = normalizeTransaction(item);
      if (normalized) await upsertTransaction(tx, current, normalized);
    }
    const [cursor] = await tx.select().from(kv).where(eq(kv.key, key));
    // A completion during the provider read must keep its new refresh request due.
    if (record(cursor?.value).generation !== savedState.generation) return;
    const value = { offset: nextOffset, ...(savedState.generation ? { generation: savedState.generation } : {}) };
    await tx.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    await tx.update(cards).set({ historySyncedAt: nextOffset ? new Date(Date.now() - 295_000) : new Date() }).where(eq(cards.id, current.id));
  });
}
export async function refreshPricing() {
  const [saved] = await db.select().from(kv).where(eq(kv.key, pricingKey));
  if (saved && Date.now() - saved.updatedAt.getTime() < 15 * 60_000) return;
  const data = record(await provider.pricing());
  const value = { issuePriceUsd: decimal(record(data.pricing).visa_issue_usd) };
  await db.insert(kv).values({ key: pricingKey, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  const limit = Number(record(data.limits).rate_limit_per_min);
  if (Number.isSafeInteger(limit) && limit > 0) await redis.set(`${providerRedisPrefix}:limit`, String(Math.max(1, Math.min(24, Math.floor(limit * 0.8)))), 'EX', 3600);
}

export async function processOneEvent(): Promise<boolean> {
  let attemptedId: string | undefined;
  try { return await db.transaction(async (tx) => {
    const [event] = await tx.select().from(cardWebhookEvents).where(and(eq(cardWebhookEvents.providerScope, providerScope), inArray(cardWebhookEvents.status, ['pending', 'unmatched']), lt(cardWebhookEvents.nextAttemptAt, new Date())))
      .orderBy(asc(cardWebhookEvents.receivedAt)).for('update', { skipLocked: true }).limit(1);
    if (!event) return false;
    attemptedId = event.id;
    const payload = event.payload;
    const cardId = identifier(payload.card_id);
    const ref = identifier(payload.client_card_ref);
    const clientRef = ref && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref) ? ref : null;
    const matchers = [cardId ? eq(cards.providerCardId, cardId) : undefined, clientRef ? eq(cards.clientCardRef, clientRef) : undefined].filter((item) => item !== undefined);
    const candidates = matchers.length ? await tx.select().from(cards).where(and(eq(cards.providerScope, providerScope), or(...matchers))).for('update') : [];
    const card = candidates.length === 1 ? candidates[0] : undefined;
    const defer = async () => {
      await tx.update(cardWebhookEvents).set({ status: 'unmatched', attempts: event.attempts + 1, nextAttemptAt: later(Math.min(3600_000, 15_000 * 2 ** Math.min(event.attempts, 8))), lastError: 'Awaiting matching provider identifiers.' }).where(eq(cardWebhookEvents.id, event.id));
    };
    const knownType = ['card.created', 'card.paid', 'card.issued', 'card.failed', 'topup.completed', 'card.transaction'].includes(event.eventType);
    if (!knownType) {
      await tx.update(cardWebhookEvents).set({ status: 'ignored', processedAt: new Date(), attempts: event.attempts + 1 }).where(eq(cardWebhookEvents.id, event.id));
      return true;
    }
    if (!card || cardId && card.providerCardId && cardId !== card.providerCardId || clientRef && clientRef !== card.clientCardRef) { await defer(); return true; }
    if (!card.providerCardId && cardId) await tx.update(cards).set({ providerCardId: cardId }).where(eq(cards.id, card.id));
    let operationId: string | null = null;
    if (event.eventType.startsWith('card.') && event.eventType !== 'card.transaction') {
      const [op] = await tx.select().from(cardOperations).where(and(eq(cardOperations.cardId, card.id), eq(cardOperations.kind, 'issue'))).for('update');
      if (!op) { await defer(); return true; }
      operationId = op.id;
      const incoming = event.eventType === 'card.issued' ? 'completed' : event.eventType === 'card.paid' ? 'processing' : event.eventType === 'card.failed' ? 'failed' : null;
      if (incoming) {
        await setOperation(tx, op, incoming);
        if (card.issueStatus !== 'issued' && op.error !== FUNDING_REVIEW) await tx.update(cards).set({ issueStatus: incoming === 'completed' ? 'issued' : incoming === 'processing' ? 'paid_pending_issue' : 'failed' }).where(eq(cards.id, card.id));
      }
    } else if (event.eventType === 'topup.completed') {
      const paymentId = identifier(payload.payment_id), topupId = identifier(payload.topup_id);
      const ids = [paymentId ? eq(cardOperations.providerPaymentId, paymentId) : undefined, topupId ? eq(cardOperations.providerTopupId, topupId) : undefined].filter((item) => item !== undefined);
      const matches = ids.length ? await tx.select().from(cardOperations).where(and(eq(cardOperations.cardId, card.id), eq(cardOperations.kind, 'topup'), or(...ids))).for('update') : [];
      if (matches.length !== 1) { await defer(); return true; }
      operationId = matches[0].id;
      await setOperation(tx, matches[0], 'completed');
    } else if (event.eventType === 'card.transaction') {
      // Stored payload is already normalized and contains only explicitly allowed fields.
      const transaction = payload.transaction as ReturnType<typeof normalizeTransaction>;
      if (transaction) await upsertTransaction(tx, card, transaction, event.eventAt);
    }
    // Events schedule a current read; never apply a possibly stale absolute balance or a delta.
    await tx.update(cards).set({ nextSyncAt: new Date(), updatedAt: new Date() }).where(eq(cards.id, card.id));
    await tx.update(cardWebhookEvents).set({ status: 'processed', cardId: card.id, operationId, processedAt: new Date(), attempts: event.attempts + 1, lastError: null }).where(eq(cardWebhookEvents.id, event.id));
    return true;
  }); } catch {
    if (!attemptedId) throw new Error('Card event inbox unavailable');
    await db.update(cardWebhookEvents).set({ status: 'unmatched', attempts: sql`${cardWebhookEvents.attempts} + 1`,
      nextAttemptAt: later(300_000), lastError: 'Event reconciliation requires a later retry.' }).where(eq(cardWebhookEvents.id, attemptedId));
    return true;
  }
}

export async function runCardsMaintenance() {
  if (!cardsEnabled()) return;
  // A global expiring scheduling lock avoids overlapping worker ticks. Row leases remain authoritative.
  const token = randomUUID(), key = `cards:maintenance:${providerScope}`;
  if (!await redis.set(key, token, 'EX', 180, 'NX')) return;
  try {
    await recoverExpiredLeases();
    for (let i = 0; i < 10; i++) if (!await processOneEvent()) break;
    for (let i = 0; i < 3; i++) if (!await submitOne()) break;
    await syncOneCard();
    // Independent read tasks can fail or exhaust the budget without losing durable work.
    for (const task of [recoverUnmatchedCards, syncOneHistory, refreshPricing]) {
      try { await task(); } catch { /* retried from durable state on the next scheduled scan */ }
    }
  } finally {
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, key, token);
  }
}
