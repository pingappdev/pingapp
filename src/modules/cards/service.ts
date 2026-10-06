import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { cardOperations, cardProfiles, cards, cardTransactions, kv, users, type Card, type CardOperation } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { AppError, errors } from '../../lib/errors.js';
import { decimal, hash, networks, payCurrency, record, requireExpectedAccount, string, usdInput, type CardNetwork } from './domain.js';
import { provider } from './provider.js';
import { issueRequestBody, issueRequestHash, productCatalog, productNetwork, profileVersionSchema, type CardProduct } from './products.js';
import { cardsEnabled, decryptCardData, encryptCardData, providerScope, requireCards, unavailable } from './settings.js';

export const pricingKey = `cards:pricing:${providerScope}`;
export function serializeOperation(op: CardOperation) {
  const hasInvoice = op.providerPaymentId || op.invoiceAddress || op.invoiceUrl;
  return {
    id: op.id, cardId: op.cardId, kind: op.kind, status: op.status,
    invoice: hasInvoice ? {
      paymentId: op.providerPaymentId, address: op.invoiceAddress, amount: decimal(op.invoiceAmount),
      payCurrency: op.payCurrency, network: op.network, expiresAt: op.invoiceExpiresAt?.toISOString() ?? null,
      url: op.invoiceUrl, amountUsd: decimal(op.amountUsd), amountOnCardUsd: decimal(op.amountOnCardUsd),
    } : null,
    error: op.error, createdAt: op.createdAt.toISOString(), updatedAt: op.updatedAt.toISOString(),
  };
}
export async function getCardsConfig() {
  const enabled = cardsEnabled();
  const [cached] = enabled ? await db.select().from(kv).where(eq(kv.key, pricingKey)).limit(1) : [];
  const prices = cached && Date.now() - cached.updatedAt.getTime() < 60 * 60 * 1000 ? cached.value : null;
  return {
    enabled, sandbox: config.IZIPAY_MODE === 'sandbox',
    products: enabled ? productCatalog(prices) : [],
    networks: enabled ? networks : [], capabilities: { freeze: false, spendingLimits: false },
    webhookDelivery: config.IZIPAY_WEBHOOK_SECRET ? 'unverified' : 'not_configured',
  };
}
async function lockUser(tx: DbTransaction, userId: string) {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  if (!user) throw errors.unauthenticated();
}
async function duplicate(tx: DbTransaction, userId: string, kind: string, requestId: string, requestHash: string) {
  const [existing] = await tx.select().from(cardOperations).where(and(eq(cardOperations.userId, userId), eq(cardOperations.kind, kind), eq(cardOperations.requestId, requestId))).limit(1);
  if (existing && existing.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 409, 'This request ID was already used for different card details.');
  return existing;
}
export async function issueCard(userId: string, input: { product: CardProduct; network: CardNetwork; requestId: string; expectedUserId: string; profileUpdatedAt?: string }) {
  requireExpectedAccount(userId, input.expectedUserId);
  const profileUpdatedAt = profileVersionSchema.parse(input.profileUpdatedAt);
  const requestHash = issueRequestHash(providerScope, { ...input, profileUpdatedAt });
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const existing = await duplicate(tx, userId, 'issue', input.requestId, requestHash);
    if (existing) return serializeOperation(existing);
    requireCards();
    const [profile] = await tx.select().from(cardProfiles).where(eq(cardProfiles.userId, userId)).limit(1);
    if (!profile) throw new AppError('CARD_EMAIL_REQUIRED', 400, 'Add your card contact email before requesting a card.');
    if (profileUpdatedAt !== undefined && profile.updatedAt.toISOString() !== profileUpdatedAt) {
      throw new AppError('CARD_PROFILE_CHANGED', 409, 'Your card profile changed. Review the latest name and email before requesting a card.');
    }
    const [active] = await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, userId), eq(cards.providerScope, providerScope), eq(cards.product, input.product), ne(cards.issueStatus, 'failed'))).limit(1);
    if (active) throw new AppError('CARD_ALREADY_EXISTS', 409, 'You already have a card or card request for this product.');
    const cardId = randomUUID(), operationId = randomUUID();
    const body = issueRequestBody({ email: decryptCardData(profile.emailEnc, `profile:${userId}`),
      cardholderName: profile.cardholderNameEnc ? decryptCardData(profile.cardholderNameEnc, `profile-name:${userId}`) : null,
      cardId, product: input.product, network: input.network });
    await tx.insert(cards).values({ id: cardId, userId, providerScope, clientCardRef: cardId, product: input.product, issueStatus: 'requested' });
    const [op] = await tx.insert(cardOperations).values({ id: operationId, userId, cardId, providerScope, kind: 'issue',
      requestId: input.requestId, providerIdempotencyKey: randomUUID(), requestHash, requestEnc: encryptCardData(body, `operation:${operationId}`),
      network: input.network, payCurrency: payCurrency(input.network) }).returning();
    return serializeOperation(op);
  });
}
export async function ownCard(userId: string, id: string) {
  const [card] = await db.select().from(cards).where(and(eq(cards.id, id), eq(cards.userId, userId), eq(cards.providerScope, providerScope))).limit(1);
  if (!card) throw errors.notFound();
  return card;
}
export async function topupCard(userId: string, cardId: string, input: { amountUsd: string; network: CardNetwork; requestId: string }) {
  let amount: string;
  try { amount = usdInput(input.amountUsd); } catch { throw errors.validation('Enter a USD amount from 0.01 to 10000 with at most two decimal places.'); }
  const requestHash = hash(JSON.stringify({ providerScope, cardId, amountUsd: amount, network: input.network }));
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const [card] = await tx.select().from(cards).where(and(eq(cards.id, cardId), eq(cards.userId, userId), eq(cards.providerScope, providerScope))).for('update').limit(1);
    if (!card) throw errors.notFound();
    const existing = await duplicate(tx, userId, 'topup', input.requestId, requestHash);
    if (existing) return serializeOperation(existing);
    requireCards();
    if (card.issueStatus !== 'issued' || !card.providerCardId) throw new AppError('CARD_NOT_READY', 409, 'Your card is not ready for a top-up yet.');
    const [pending] = await tx.select({ id: cardOperations.id }).from(cardOperations).where(and(eq(cardOperations.cardId, cardId), sql`${cardOperations.status} not in ('completed', 'failed')`)).limit(1);
    if (pending) throw new AppError('CARD_OPERATION_PENDING', 409, 'Your previous card payment is still pending or requires review.');
    const operationId = randomUUID();
    // Construct the numeric JSON token from validated decimal text without float arithmetic.
    const body = `{"amount_usd":${amount},"pay_currency":${JSON.stringify(payCurrency(input.network))}}`;
    const [op] = await tx.insert(cardOperations).values({ id: operationId, userId, cardId, providerScope, kind: 'topup',
      requestId: input.requestId, providerIdempotencyKey: randomUUID(), requestHash, requestEnc: encryptCardData(body, `operation:${operationId}`),
      amountUsd: amount, network: input.network, payCurrency: payCurrency(input.network) }).returning();
    return serializeOperation(op);
  });
}
export async function getOperation(userId: string, id: string) {
  const [op] = await db.select().from(cardOperations).where(and(eq(cardOperations.id, id), eq(cardOperations.userId, userId), eq(cardOperations.providerScope, providerScope))).limit(1);
  if (!op) throw errors.notFound();
  return serializeOperation(op);
}
function summary(card: Card, latest: CardOperation | undefined) {
  const now = new Date();
  return {
    id: card.id, product: card.product, network: productNetwork(card.product), currency: 'USD', issueStatus: card.issueStatus,
    last4: card.last4, frozen: card.isFrozen, balanceUsd: decimal(card.balanceUsd), pendingTopupUsd: decimal(card.pendingTopupUsd),
    balanceAsOf: card.balanceAsOf?.toISOString() ?? null, issuedAt: card.issuedAt?.toISOString() ?? null, createdAt: card.createdAt.toISOString(),
    latestOperation: latest ? serializeOperation(latest) : null,
    // Pagination coverage alone does not establish issuer retention or settled billed-USD completeness.
    monthlySpending: { amountUsd: null, complete: false, periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() },
  };
}
export async function listCards(userId: string) {
  const rows = await db.select().from(cards).where(and(eq(cards.userId, userId), eq(cards.providerScope, providerScope))).orderBy(desc(cards.createdAt));
  if (!rows.length) return [];
  const operations = await db.select().from(cardOperations).where(and(eq(cardOperations.userId, userId), inArray(cardOperations.cardId, rows.map((row) => row.id)))).orderBy(desc(cardOperations.createdAt), desc(cardOperations.id));
  return rows.map((row) => summary(row, operations.find((op) => op.cardId === row.id)));
}
export async function getCard(userId: string, id: string) {
  const card = await ownCard(userId, id);
  const [op] = await db.select().from(cardOperations).where(eq(cardOperations.cardId, id)).orderBy(desc(cardOperations.createdAt), desc(cardOperations.id)).limit(1);
  // Screen reads only schedule a bounded shared refresh; they never call the issuer directly.
  if (cardsEnabled() && (!card.balanceAsOf || Date.now() - card.balanceAsOf.getTime() > 60_000)) {
    await db.update(cards).set({ nextSyncAt: new Date() }).where(and(eq(cards.id, id), sql`${cards.nextSyncAt} > now()`));
  }
  return summary(card, op);
}
export async function getTransactions(userId: string, id: string, limit: number, cursor?: string) {
  await ownCard(userId, id);
  let after;
  if (cursor) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      const token = record(parsed);
      if (token.cardId !== id || typeof token.id !== 'string' || !/^[0-9a-f-]{36}$/.test(token.id) || typeof token.at !== 'string' || !Number.isFinite(new Date(token.at).getTime())) throw new Error();
      after = or(lt(cardTransactions.occurredAt, new Date(token.at)), and(eq(cardTransactions.occurredAt, new Date(token.at)), lt(cardTransactions.id, token.id)));
    } catch { throw errors.validation('Invalid history cursor.'); }
  }
  const rows = await db.select().from(cardTransactions).where(and(eq(cardTransactions.cardId, id), after)).orderBy(desc(cardTransactions.occurredAt), desc(cardTransactions.id)).limit(limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return {
    items: page.map((row) => ({ id: row.id, type: row.type, status: row.status, amount: decimal(row.amount)!, currency: row.currency,
      merchant: row.merchant, occurredAt: row.occurredAt.toISOString(), direction: row.direction })),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ cardId: id, at: last.occurredAt.toISOString(), id: last.id })).toString('base64url') : null,
    complete: false,
  };
}
export async function revealCard(userId: string, id: string) {
  const card = await ownCard(userId, id);
  requireCards();
  if (card.issueStatus !== 'issued' || !card.providerCardId) throw new AppError('CARD_NOT_READY', 409, 'Your card details are not ready yet.');
  try {
    const data = record(await provider.card(card.providerCardId));
    if (data.card_id !== card.providerCardId || data.issue_status !== 'issued') throw unavailable();
    const details = record(data.card);
    const number = string(details.number, 32)?.replace(/\s/g, '');
    const expiry = string(details.exp, 7), cvv = string(details.cvv, 4);
    if (!number || !/^\d{13,19}$/.test(number) || !expiry || !/^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/.test(expiry) || !cvv || !/^\d{3,4}$/.test(cvv)) throw unavailable();
    return { number, expiry, cvv, holderName: string(data.cardholder_alias, 100) };
  } catch { throw unavailable(); }
}
