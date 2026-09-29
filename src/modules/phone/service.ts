import { and, eq, gt, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { notify } from '../../db/notify.js';
import { intents, phoneClaims, sessions, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { encrypt, phoneHmac, randomOtp, sha256Hex } from '../../lib/crypto.js';
import { AppError, errors } from '../../lib/errors.js';
import { normalizePhone, type NormalizedPhone } from '../../lib/phone.js';
import { consume, limits } from '../../lib/rateLimit.js';
import { redis } from '../../lib/redis.js';
import { sendSms } from '../../lib/sms.js';
import { markIntentsReady } from '../intents/ready.js';
import { serializeMe } from '../me/serialize.js';
import { checkOtp, type OtpState } from './otp.js';

const OTP_TTL_SEC = 600;
const otpKey = (userId: string) => `otp:${userId}`;

function otpExpired(message = 'This code has expired. Request a new one.'): AppError {
  return new AppError('OTP_EXPIRED', 400, message);
}

function claimBlocked(claimId: string): AppError {
  return new AppError('PHONE_LINKED_ELSEWHERE', 409,
    `This number is linked to another PingApp wallet. For your safety we've opened a manual review. Contact ${config.SUPPORT_CONTACT} to complete the move.`,
    { claimId, support: config.SUPPORT_CONTACT });
}

async function lockKey(tx: DbTransaction, value: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${value}, 0))`);
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

export async function requestOtp(userId: string, sessionId: string, rawPhone: string, ipHash: string) {
  const p = normalizePhone(rawPhone);
  const h = phoneHmac(p.e164);
  const user = await currentUser(userId);
  if (user.phoneHmac === h) throw errors.conflict('This number is already linked to your wallet.');
  const [pending] = await db.select({ id: phoneClaims.id }).from(phoneClaims)
    .where(and(eq(phoneClaims.claimantUserId, userId), eq(phoneClaims.phoneHmac, h),
      eq(phoneClaims.status, 'pending_review'))).limit(1);
  if (pending) throw new AppError('CLAIM_PENDING', 409, 'Your request to link this number is under review.');
  if (user.phoneHmac) await ensureFresh(sessionId, userId);

  await consume(limits.otpPhoneBurst, h);
  await consume(limits.otpUserDay, userId);
  await consume(limits.otpIpDay, ipHash);
  await consume(limits.otpPhoneDay, h);

  const code = randomOtp();
  const now = Date.now();
  const state: OtpState = {
    phoneHmac: h,
    codeHash: sha256Hex(`${code}:${h}:${userId}`),
    attempts: 0,
    createdAt: now,
  };
  const serialized = JSON.stringify(state);
  await redis.set(otpKey(userId), serialized, 'EX', OTP_TTL_SEC);
  try {
    await sendSms({
      purpose: 'otp', toE164: p.e164, phoneHmac: h, country: p.country,
      text: `Your PingApp code is ${code}. It expires in 10 minutes. Never share it with anyone.\n\n@${new URL(config.APP_URL).host} #${code}`,
    });
  } catch (error) {
    // A later request can replace this user's OTP while the SMS request is in flight.
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, otpKey(userId), serialized);
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
 * Caller must commit the supplied transaction even for `claimed`. Only after
 * commit should an HTTP caller turn that sentinel into PHONE_LINKED_ELSEWHERE.
 * BE-17 may call this without sessionId after its own admin authorization.
 */
export async function linkPhoneToUser(
  tx: DbTransaction, userId: string, p: NormalizedPhone, meta: LinkPhoneMeta = {},
): Promise<LinkPhoneResult> {
  const h = phoneHmac(p.e164);
  // This order is shared with unlink: serialize one user's edits, then each
  // phone key. The advisory key covers absent-owner races before the unique
  // constraint can fire. The user row is locked before its old value is read.
  await lockKey(tx, `user:${userId}`);
  const [me] = await tx.select().from(users).where(eq(users.id, userId)).for('update').limit(1);
  if (!me) throw errors.unauthenticated();
  for (const key of [...new Set([h, me.phoneHmac].filter((x): x is string => !!x))].sort()) {
    await lockKey(tx, `phone:${key}`);
  }
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
    await tx.update(intents).set({ status: 'pending', recipientUserId: null, readyAt: null })
      .where(and(eq(intents.recipientUserId, userId), eq(intents.status, 'ready'),
        eq(intents.recipientPhoneHmac, me.phoneHmac)));
  }
  await audit(me.phoneHmac ? 'phone_changed' : 'phone_linked', {
    userId, data: { phoneMasked: p.masked, previousMasked: me.phoneMasked }, ipHash: meta.ipHash,
  }, tx);
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
    await lockKey(tx, `user:${userId}`);
    const [me] = await tx.select().from(users).where(eq(users.id, userId)).for('update').limit(1);
    if (!me) throw errors.unauthenticated();
    await ensureFresh(sessionId, userId, tx);
    if (!me.phoneHmac) return;
    await lockKey(tx, `phone:${me.phoneHmac}`);
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
    await lockKey(tx, `user:${userId}`);
    const rows = await tx.update(phoneClaims).set({ status: 'cancelled', resolvedAt: new Date() })
      .where(and(eq(phoneClaims.claimantUserId, userId), eq(phoneClaims.status, 'pending_review')))
      .returning({ id: phoneClaims.id, phoneMasked: phoneClaims.phoneMasked });
    for (const row of rows) {
      await audit('phone_claim_cancelled', { userId, data: { claimId: row.id, phoneMasked: row.phoneMasked }, ipHash }, tx);
    }
  });
}
