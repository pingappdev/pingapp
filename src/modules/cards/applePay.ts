import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { redis } from '../../lib/redis.js';
import { record, string } from './domain.js';
import { provider, providerRedisPrefix } from './provider.js';
import { ownCard } from './service.js';
import { decryptCardData, encryptCardData, requireCards, unavailable } from './settings.js';

/**
 * Apple Pay activation for the Apple Pay Mastercard product. Izipay matches the
 * issuer's code email to an armed card by timing only, so arming is exclusive
 * across the whole provider account, not per user. Codes are never written to the
 * database or logs: a delivered code is kept encrypted in Redis until it expires.
 */
const ARM_SECONDS = 600;
const POLL_SECONDS = 8;
const lockKey = `${providerRedisPrefix}:apple-pay:armed`;
const codeKey = (cardId: string) => `${providerRedisPrefix}:apple-pay:code:${cardId}`;
const pollKey = (cardId: string) => `${providerRedisPrefix}:apple-pay:poll:${cardId}`;
type Arm = { cardId: string; userId: string; expiresAt: number };

// Take the lock if it is free or already held by the same card; otherwise return its TTL.
const armScript = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current).cardId ~= ARGV[2] then return -redis.call('TTL', KEYS[1]) end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1`;
// Release only a lock this card holds.
const releaseScript = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current).cardId == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export type ApplePayState =
  | { status: 'idle' }
  | { status: 'waiting'; expiresAt: string }
  | { status: 'delivered'; code: string; expiresAt: string };

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
    return typeof value.cardId === 'string' && typeof value.userId === 'string' && Number.isFinite(value.expiresAt) ? value : null;
  } catch { return null; }
}

async function deliveredCode(cardId: string): Promise<ApplePayState | null> {
  const raw = await redis.get(codeKey(cardId));
  if (!raw) return null;
  try {
    const { code, expiresAt } = JSON.parse(decryptCardData(raw, `apple-pay:${cardId}`)) as { code: string; expiresAt: number };
    return { status: 'delivered', code, expiresAt: new Date(expiresAt).toISOString() };
  } catch { return null; }
}

export async function armApplePay(userId: string, id: string): Promise<ApplePayState> {
  const card = await applePayCard(userId, id);
  const expiresAt = Date.now() + ARM_SECONDS * 1000;
  const arm: Arm = { cardId: card.id, userId, expiresAt };
  const taken = Number(await redis.eval(armScript, 1, lockKey, JSON.stringify(arm), card.id, String(ARM_SECONDS)));
  if (taken !== 1) {
    const minutes = Math.max(1, Math.ceil(Math.max(-taken, 1) / 60));
    throw new AppError('APPLE_PAY_BUSY', 409,
      `Another Apple Pay activation is in progress. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { retryAfterSec: Math.max(-taken, 1) });
  }
  await redis.del(codeKey(card.id), pollKey(card.id));
  try {
    const data = record(await provider.armApplePay(card.providerCardId));
    if (data.card_id !== card.providerCardId || data.status !== 'armed') throw unavailable();
  } catch {
    await redis.eval(releaseScript, 1, lockKey, card.id).catch(() => {});
    throw unavailable();
  }
  return { status: 'waiting', expiresAt: new Date(expiresAt).toISOString() };
}

export async function getApplePayCode(userId: string, id: string): Promise<ApplePayState> {
  const card = await applePayCard(userId, id);
  const delivered = await deliveredCode(card.id);
  if (delivered) return delivered;
  const arm = await readArm();
  if (!arm || arm.cardId !== card.id || arm.userId !== userId || arm.expiresAt <= Date.now()) return { status: 'idle' };
  const waiting: ApplePayState = { status: 'waiting', expiresAt: new Date(arm.expiresAt).toISOString() };
  // Browsers poll often; the provider is asked at most once per POLL_SECONDS per card.
  if (!await redis.set(pollKey(card.id), '1', 'EX', POLL_SECONDS, 'NX')) return waiting;
  let data: Record<string, unknown>;
  try { data = record(await provider.applePayCode(card.providerCardId)); } catch { return waiting; }
  if (data.card_id !== card.providerCardId) return waiting;
  const code = string(data.code, 12);
  if (data.status !== 'delivered' || !code || !/^\d{4,10}$/.test(code)) return waiting;
  const ttl = Math.max(1, Math.ceil((arm.expiresAt - Date.now()) / 1000));
  await redis.set(codeKey(card.id), encryptCardData(JSON.stringify({ code, expiresAt: arm.expiresAt }), `apple-pay:${card.id}`), 'EX', ttl);
  // The code is matched, so another card may arm now.
  await redis.eval(releaseScript, 1, lockKey, card.id);
  return { status: 'delivered', code, expiresAt: new Date(arm.expiresAt).toISOString() };
}
