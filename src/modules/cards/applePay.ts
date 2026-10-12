import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { redis } from '../../lib/redis.js';
import { record, string } from './domain.js';
import { provider, ProviderError, providerRedisPrefix } from './provider.js';
import { ownCard } from './service.js';
import { decryptCardData, encryptCardData, requireCards, unavailable } from './settings.js';

/**
 * Apple Pay activation for the Apple Pay Mastercard product. Izipay matches the
 * issuer's code email to an armed card by timing only, so arming is exclusive
 * across the whole provider account, not per user. The lock lasts the whole arm
 * window (plus a margin), even after a code arrives: the provider does not say a
 * match ends the arm, and a live window is never re-armed or extended. Codes are never
 * written to the database or logs: a delivered code is kept encrypted in Redis until
 * the window ends.
 */
const ARM_SECONDS = 600;
// Covers the provider's latency in starting its own 10-minute window.
const LOCK_MARGIN_SECONDS = 30;
// One provider poll per 15 s keeps an activation near 40 calls of the shared budget.
const POLL_SECONDS = 15;
const lockKey = `${providerRedisPrefix}:apple-pay:armed`;
const codeKey = (cardId: string) => `${providerRedisPrefix}:apple-pay:code:${cardId}`;
const pollKey = (cardId: string) => `${providerRedisPrefix}:apple-pay:poll:${cardId}`;
type Arm = { cardId: string; userId: string; expiresAt: number; nonce: string };

// 1: lock taken. 0: this card already holds a live window. Negative: another card's TTL.
const armScript = `
local current = redis.call('GET', KEYS[1])
if current then
  if cjson.decode(current).cardId == ARGV[2] then return 0 end
  return -redis.call('TTL', KEYS[1])
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1`;
// Release only the arm this request created.
const releaseScript = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current).nonce == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
// Store a code only for the arm it was polled under, never for a newer one.
const deliverScript = `
local current = redis.call('GET', KEYS[1])
if not current or cjson.decode(current).nonce ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1`;

export type ApplePayState =
  | { status: 'idle' }
  | { status: 'waiting'; expiresAt: string; expiresInSec: number }
  | { status: 'delivered'; code: string; expiresAt: string; expiresInSec: number };

const windowOf = (expiresAt: number) => ({
  expiresAt: new Date(expiresAt).toISOString(),
  expiresInSec: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
});

async function applePayCard(userId: string, id: string) {
  const card = await ownCard(userId, id);
  requireCards();
  if (card.product !== 'mastercard') {
    throw new AppError('APPLE_PAY_UNSUPPORTED', 409, 'Apple Pay activation is available for the Mastercard card type only.');
  }
  // Izipay answers 403 SANDBOX_NOT_AVAILABLE for these endpoints in sandbox.
  if (config.IZIPAY_MODE === 'sandbox') {
    throw new AppError('APPLE_PAY_UNSUPPORTED', 409, 'Apple Pay activation needs a live card. It is not available in sandbox mode.');
  }
  if (card.issueStatus !== 'issued' || !card.providerCardId) throw new AppError('CARD_NOT_READY', 409, 'Your card is not ready yet.');
  return { ...card, providerCardId: card.providerCardId };
}

async function readArm(): Promise<Arm | null> {
  const raw = await redis.get(lockKey);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Arm;
    return typeof value.cardId === 'string' && typeof value.userId === 'string' && typeof value.nonce === 'string' &&
      Number.isFinite(value.expiresAt) ? value : null;
  } catch { return null; }
}

async function deliveredCode(cardId: string): Promise<ApplePayState | null> {
  const raw = await redis.get(codeKey(cardId));
  if (!raw) return null;
  try {
    const { code, expiresAt } = JSON.parse(decryptCardData(raw, `apple-pay:${cardId}`)) as { code: string; expiresAt: number };
    return expiresAt > Date.now() ? { status: 'delivered', code, ...windowOf(expiresAt) } : null;
  } catch { return null; }
}

async function currentState(userId: string, cardId: string): Promise<ApplePayState> {
  const delivered = await deliveredCode(cardId);
  if (delivered) return delivered;
  const arm = await readArm();
  if (!arm || arm.cardId !== cardId || arm.userId !== userId || arm.expiresAt <= Date.now()) return { status: 'idle' };
  return { status: 'waiting', ...windowOf(arm.expiresAt) };
}

export async function armApplePay(userId: string, id: string): Promise<ApplePayState> {
  const card = await applePayCard(userId, id);
  const arm: Arm = { cardId: card.id, userId, expiresAt: Date.now() + ARM_SECONDS * 1000, nonce: crypto.randomUUID() };
  const taken = Number(await redis.eval(armScript, 1, lockKey, JSON.stringify(arm), card.id, String(ARM_SECONDS + LOCK_MARGIN_SECONDS)));
  // A second tab or a double click joins the live window instead of re-arming it.
  if (taken === 0) return currentState(userId, card.id);
  if (taken !== 1) {
    const seconds = Math.max(-taken, 1), minutes = Math.ceil(seconds / 60);
    throw new AppError('APPLE_PAY_BUSY', 409,
      `Another Apple Pay activation is in progress. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { retryAfterSec: seconds });
  }
  await redis.del(codeKey(card.id), pollKey(card.id));
  try {
    const data = record(await provider.armApplePay(card.providerCardId));
    if (data.card_id !== card.providerCardId || data.status !== 'armed') throw unavailable();
  } catch (error) {
    // After an uncertain outcome izipay may be armed, so the lock runs its course.
    if (error instanceof ProviderError && error.outcome !== 'unknown') {
      await redis.eval(releaseScript, 1, lockKey, arm.nonce).catch(() => {});
    }
    throw unavailable();
  }
  return { status: 'waiting', ...windowOf(arm.expiresAt) };
}

export async function getApplePayCode(userId: string, id: string): Promise<ApplePayState> {
  const card = await applePayCard(userId, id);
  const state = await currentState(userId, card.id);
  if (state.status !== 'waiting') return state;
  const arm = await readArm();
  if (!arm) return { status: 'idle' };
  // Browsers poll often; the provider is asked at most once per POLL_SECONDS per card.
  if (!await redis.set(pollKey(card.id), '1', 'EX', POLL_SECONDS, 'NX')) return state;
  let data: Record<string, unknown>;
  try { data = record(await provider.applePayCode(card.providerCardId)); } catch { return state; }
  if (data.card_id !== card.providerCardId) return state;
  const code = string(data.code, 12);
  if (data.status !== 'delivered' || !code || !/^\d{4,10}$/.test(code)) return state;
  const ttl = Math.max(1, Math.ceil((arm.expiresAt - Date.now()) / 1000));
  const sealed = encryptCardData(JSON.stringify({ code, expiresAt: arm.expiresAt }), `apple-pay:${card.id}`);
  const stored = Number(await redis.eval(deliverScript, 2, lockKey, codeKey(card.id), arm.nonce, sealed, String(ttl)).catch(() => -1));
  // 0: a newer arm replaced this one while the provider answered; its own poll reports.
  if (stored === 0) return currentState(userId, card.id);
  return { status: 'delivered', code, ...windowOf(arm.expiresAt) };
}
