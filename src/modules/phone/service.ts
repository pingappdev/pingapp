import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { config } from '../../config.js';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { notify } from '../../db/notify.js';
import { escrows, intents, phoneClaims, sessions, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { encrypt, phoneHmac, randomOtp, sha256Hex } from '../../lib/crypto.js';
import { AppError, errors } from '../../lib/errors.js';
import { normalizePhone, type NormalizedPhone } from '../../lib/phone.js';
import { consume, limits } from '../../lib/rateLimit.js';
import { redis } from '../../lib/redis.js';
import { sendSms, type SmsProvider } from '../../lib/sms.js';
import { markIntentsReady } from '../intents/ready.js';
import { clearEscrowRecipient, markEscrowsClaimable } from '../escrows/ready.js';
import { serializeMe } from '../me/serialize.js';
import { lockPhoneMutation } from './lock.js';
import { checkOtp, type OtpState } from './otp.js';

export { lockPhoneMutation } from './lock.js';

const OTP_TTL_SEC = 600;
const otpKey = (userId: string) => `otp:${userId}`;
const otpSequenceKey = (userId: string) => `otp:sequence:${userId}`;
const otpAcceptedKey = (userId: string) => `otp:accepted:${userId}`;
// Keep generations alive longer than accepted markers and the full pending-code/provider window.
const OTP_SEQUENCE_TTL_SEC = 49 * 60 * 60;
const OTP_ACCEPTED_TTL_SEC = 48 * 60 * 60;
const otpPendingKey = (userId: string, requestId: string) => `otp:pending:${userId}:${requestId}`;

const NEXT_OTP_SEQUENCE_SCRIPT = `
local next = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return next
`;

const PROMOTE_PENDING_OTP_SCRIPT = `
local generation = tonumber(ARGV[2])
local current = redis.call('GET', KEYS[1])
local accepted = tonumber(redis.call('GET', KEYS[3]) or '0')
local currentGeneration = 0
if current then
  local ok, parsed = pcall(cjson.decode, current)
  if ok then currentGeneration = tonumber(parsed.generation or 0) end
end
local latestAccepted = math.max(accepted, currentGeneration)
if latestAccepted > generation then
  redis.call('DEL', KEYS[2])
  return 0
end
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  if currentGeneration == generation and accepted == generation then return 1 end
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[3], tostring(generation), 'EX', ARGV[4])
redis.call('DEL', KEYS[2])
return 1
`;

const DELETE_PENDING_OTP_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

function otpExpired(message = 'This code has expired. Request a new one.'): AppError {
  return new AppError('OTP_EXPIRED', 400, message);
}

function claimBlocked(claimId: string): AppError {
  const contact = config.SUPPORT_CONTACT
    ? ` Contact ${config.SUPPORT_CONTACT} to complete the move.`
    : ' An operator will review your request.';
  return new AppError('PHONE_LINKED_ELSEWHERE', 409,
    `This number is linked to another PingApp wallet. For your safety we've opened a manual review.${contact}`,
    { claimId, support: config.SUPPORT_CONTACT });
}

async function ensureFresh(sessionId: string, userId: string, tx: DbTransaction | typeof db = db): Promise<void> {
  const [session] = await tx.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId),
      gt(sessions.freshUntil, new Date()), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!session) throw errors.reauthRequired();
}

async function currentUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw errors.unauthenticated();
  return user;
}

async function matchingFundedClaim(phoneHash: string, claimCode: string | undefined): Promise<string | null> {
  if (!claimCode || !/^[A-Za-z0-9]{10}$/.test(claimCode)) return null;
  const [row] = await db.select({ id: escrows.id }).from(escrows).where(and(
    eq(escrows.code, claimCode), eq(escrows.recipientPhoneHmac, phoneHash),
    inArray(escrows.status, ['deposited', 'claiming']), gt(escrows.expiresAt, new Date()),
    isNotNull(escrows.depositTxHash), gt(escrows.amountRaw, '0'),
  )).limit(1);
  return row?.id ?? null;
}

export async function requestOtp(
  userId: string, sessionId: string, rawPhone: string, ipHash: string,
  claimCode?: string, provider?: SmsProvider,
) {
  const p = normalizePhone(rawPhone);
  const h = phoneHmac(p.e164);
  // A bearer claim code and the exact normalized recipient phone are both needed
  // before an OTP can use the protected, funded-claim allocation.
  const depositId = await matchingFundedClaim(h, claimCode);
  const budgetLane = depositId ? 'claim_otp' : 'onboarding';
  const user = await currentUser(userId);
  if (user.phoneHmac === h) throw errors.conflict('This number is already linked to your wallet.');
  const [pending] = await db.select({ id: phoneClaims.id }).from(phoneClaims)
    .where(and(eq(phoneClaims.claimantUserId, userId), eq(phoneClaims.phoneHmac, h),
      eq(phoneClaims.status, 'pending_review'))).limit(1);
  if (pending) throw new AppError('CLAIM_PENDING', 409, 'Your request to link this number is under review.');
  if (user.phoneHmac) await ensureFresh(sessionId, userId);

  const code = randomOtp();
  const now = Date.now();
  const requestId = randomUUID();
  const generation = Number(await redis.eval(NEXT_OTP_SEQUENCE_SCRIPT, 1, otpSequenceKey(userId), String(OTP_SEQUENCE_TTL_SEC)));
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('OTP generation reservation failed.');
  const state: OtpState = {
    phoneHmac: h,
    codeHash: sha256Hex(`${code}:${h}:${userId}`),
    attempts: 0,
    createdAt: now,
    generation,
  };
  const serialized = JSON.stringify(state);
  const pendingKey = otpPendingKey(userId, requestId);
  await redis.set(pendingKey, serialized, 'EX', OTP_TTL_SEC);
  try {
    await sendSms({
      purpose: 'otp', budgetLane, toE164: p.e164, phoneHmac: h, country: p.country,
      text: `Your PingApp code is ${code}. It expires in 10 minutes. Never share it with anyone.\n\n@${new URL(config.APP_URL).host} #${code}`,
    }, {
      provider,
      beforeProvider: async () => {
        await consume(limits.otpUserDay, userId);
        await consume(limits.otpIpDay, ipHash);
        if (depositId) {
          await consume(limits.claimOtpPhoneBurst, h);
          await consume(limits.claimOtpPhoneDay, h);
          await consume(limits.claimOtpDepositDay, `${depositId}:${h}`);
        } else {
          await consume(limits.otpPhoneBurst, h);
          await consume(limits.otpPhoneDay, h);
        }
      },
    });
    await redis.eval(PROMOTE_PENDING_OTP_SCRIPT, 3, otpKey(userId), pendingKey, otpAcceptedKey(userId),
      serialized, String(generation), String(OTP_TTL_SEC), String(OTP_ACCEPTED_TTL_SEC));
  } catch (error) {
    // Keep the previous current code on failure and remove only this request's staged code.
    await redis.eval(DELETE_PENDING_OTP_SCRIPT, 1, pendingKey, serialized);
    throw error;
  }
  await audit('otp_requested', { userId, data: { phoneMasked: p.masked, country: p.country }, ipHash });
  return { phoneMasked: p.masked, expiresAt: new Date(now + OTP_TTL_SEC * 1000).toISOString(), resendAfterSec: 60 };
}

export type LinkPhoneMeta = { ipHash?: string | null; sessionId?: string };
export type LinkPhoneResult =
  | { kind: 'linked'; readyIntents: number }
  | { kind: 'claimed'; claimId: string };

/**
 * Caller must acquire lockPhoneMutation before ANY row lock in its transaction;
 * this function acquires it as well for direct callers. Caller must commit
 * the supplied transaction even for `claimed`. Only after
 * commit should an HTTP caller turn that sentinel into PHONE_LINKED_ELSEWHERE.
 * BE-17 may call this without sessionId after its own admin authorization.
 */
export async function linkPhoneToUser(
  tx: DbTransaction, userId: string, p: NormalizedPhone, meta: LinkPhoneMeta = {},
): Promise<LinkPhoneResult> {
  const h = phoneHmac(p.e164);
  await lockPhoneMutation(tx);
  const [me] = await tx.select().from(users).where(eq(users.id, userId)).for('update').limit(1);
  if (!me) throw errors.unauthenticated();
  if (me.phoneHmac === h) throw errors.conflict('This number is already linked to your wallet.');
  if (me.phoneHmac && meta.sessionId) await ensureFresh(meta.sessionId, userId, tx);

  let [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.phoneHmac, h)).limit(1);
  if (!owner) {
    try {
      // Savepoint keeps the outer transaction usable if an external writer
      // races this helper and the database unique constraint wins.
      await tx.transaction(async (savepoint) => {
        await savepoint.update(users).set({
          phoneHmac: h, phoneEnc: encrypt(p.e164), phoneCountry: p.country,
          phoneMasked: p.masked, phoneLinkedAt: new Date(),
        }).where(eq(users.id, userId));
      });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === '23505')) throw error;
      [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.phoneHmac, h)).limit(1);
      if (!owner) throw error;
    }
  }

  if (owner && owner.id !== userId) {
    const [inserted] = await tx.insert(phoneClaims).values({
      phoneHmac: h, phoneEnc: encrypt(p.e164), phoneMasked: p.masked,
      claimantUserId: userId, ownerUserId: owner.id,
    }).onConflictDoNothing().returning({ id: phoneClaims.id });
    const [existing] = inserted ? [inserted] : await tx.select({ id: phoneClaims.id }).from(phoneClaims)
      .where(and(eq(phoneClaims.phoneHmac, h), eq(phoneClaims.claimantUserId, userId),
        eq(phoneClaims.status, 'pending_review'))).limit(1);
    if (!existing) throw new Error('Pending phone claim missing after conflict.');
    if (inserted) {
      await notify(owner.id, 'phone_claim_attempt', { phoneMasked: p.masked }, tx);
      await audit('phone_claim_opened', {
        userId, data: { claimId: existing.id, phoneMasked: p.masked }, ipHash: meta.ipHash,
      }, tx);
    }
    return { kind: 'claimed', claimId: existing.id };
  }

  if (me.phoneHmac) {
    await clearEscrowRecipient(tx, userId, me.phoneHmac);
    await tx.update(intents).set({ status: 'pending', recipientUserId: null, readyAt: null })
      .where(and(eq(intents.recipientUserId, userId), eq(intents.status, 'ready'),
        eq(intents.recipientPhoneHmac, me.phoneHmac)));
  }
  await audit(me.phoneHmac ? 'phone_changed' : 'phone_linked', {
    userId, data: { phoneMasked: p.masked, previousMasked: me.phoneMasked }, ipHash: meta.ipHash,
  }, tx);
  await markEscrowsClaimable(tx, h, userId);
  return { kind: 'linked', readyIntents: await markIntentsReady(tx, h, userId) };
}

export async function verifyOtp(userId: string, sessionId: string, rawPhone: string, code: string, ipHash: string) {
  await consume(limits.otpVerifyUserHour, userId);
  const p = normalizePhone(rawPhone);
  const h = phoneHmac(p.e164);
  const client = redis.duplicate();
  let decision: ReturnType<typeof checkOtp>;
  try {
    for (;;) {
      await client.watch(otpKey(userId));
      const raw = await client.get(otpKey(userId));
      let state: OtpState | null = null;
      if (raw) {
        try { state = JSON.parse(raw) as OtpState; } catch { /* Expire corrupt state. */ }
      }
      if (!state || state.phoneHmac !== h) {
        await client.unwatch();
        throw otpExpired();
      }
      const user = await currentUser(userId);
      if (user.phoneHmac && user.phoneHmac !== h) {
        try { await ensureFresh(sessionId, userId); } catch (error) {
          await client.unwatch();
          throw error;
        }
      }
      decision = checkOtp(state, h, userId, code);
      const transaction = client.multi();
      if (decision.state) transaction.set(otpKey(userId), JSON.stringify(decision.state), 'KEEPTTL');
      else transaction.del(otpKey(userId));
      const result = await transaction.exec();
      if (result !== null) break; // Another verify or OTP request won; read again.
    }
  } finally {
    await client.quit();
  }

  if (decision.result === 'invalid') throw errors.otpInvalid(5 - decision.state!.attempts);
  if (decision.result === 'expired') throw otpExpired('Too many incorrect attempts. Request a new code.');
  const linked = await db.transaction((tx) => linkPhoneToUser(tx, userId, p, { ipHash, sessionId }));
  if (linked.kind === 'claimed') throw claimBlocked(linked.claimId);
  return { me: await serializeMe(userId, sessionId), readyIntents: linked.readyIntents };
}

export async function unlinkPhone(userId: string, sessionId: string, ipHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const [me] = await tx.select().from(users).where(eq(users.id, userId)).for('update').limit(1);
    if (!me) throw errors.unauthenticated();
    await ensureFresh(sessionId, userId, tx);
    if (!me.phoneHmac) return;
    await clearEscrowRecipient(tx, userId, me.phoneHmac);
    await tx.update(users).set({ phoneHmac: null, phoneEnc: null, phoneCountry: null,
      phoneMasked: null, phoneLinkedAt: null }).where(eq(users.id, userId));
    await tx.update(intents).set({ status: 'pending', recipientUserId: null, readyAt: null })
      .where(and(eq(intents.recipientUserId, userId), eq(intents.recipientPhoneHmac, me.phoneHmac),
        eq(intents.status, 'ready')));
    await audit('phone_unlinked', { userId, data: { phoneMasked: me.phoneMasked }, ipHash }, tx);
  });
}

export async function cancelClaim(userId: string, ipHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const rows = await tx.update(phoneClaims).set({ status: 'cancelled', resolvedAt: new Date() })
      .where(and(eq(phoneClaims.claimantUserId, userId), eq(phoneClaims.status, 'pending_review')))
      .returning({ id: phoneClaims.id, phoneMasked: phoneClaims.phoneMasked });
    for (const row of rows) {
      await audit('phone_claim_cancelled', { userId, data: { claimId: row.id, phoneMasked: row.phoneMasked }, ipHash }, tx);
    }
  });
}

/**
 * For BE-17 approval or support unlink. The caller must acquire
 * lockPhoneMutation before locking the claim or any user row. Never clear a
 * former owner's new phone: the expected HMAC is part of the UPDATE predicate.
 * The caller owns any operation-specific audit event or notification.
 */
export async function clearPhoneIfOwned(
  tx: DbTransaction, ownerId: string, expectedPhoneHmac: string,
): Promise<boolean> {
  await lockPhoneMutation(tx);
  const [cleared] = await tx.update(users).set({
    phoneHmac: null, phoneEnc: null, phoneCountry: null,
    phoneMasked: null, phoneLinkedAt: null,
  }).where(and(eq(users.id, ownerId), eq(users.phoneHmac, expectedPhoneHmac)))
    .returning({ id: users.id });
  if (!cleared) return false;
  await clearEscrowRecipient(tx, ownerId, expectedPhoneHmac);
  await tx.update(intents).set({ status: 'pending', recipientUserId: null, readyAt: null })
    .where(and(eq(intents.recipientUserId, ownerId),
      eq(intents.recipientPhoneHmac, expectedPhoneHmac), eq(intents.status, 'ready')));
  return true;
}
