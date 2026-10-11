import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { intents, phoneClaims, transfers, users } from '../../db/schema.js';
import { phoneHmac } from '../../lib/crypto.js';
import { AppError, errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { normalizePhone } from '../../lib/phone.js';
import { consume, limits } from '../../lib/rateLimit.js';
import { redis } from '../../lib/redis.js';
import type { AuthUser } from '../../plugins/auth.js';
import { recipientRef } from './recipientRef.js';

const MAX_DISTINCT_NUMBERS_PER_DAY = 60;
const DISTINCT_NUMBERS_TTL_SEC = 2 * 24 * 60 * 60;

// Membership, capacity checking and insertion must be one Redis operation. In
// particular, a rejected 61st number must not become a member that can retry.
const addDistinctPhoneWithinCapLua = `
local isMember = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if isMember == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  return 0
end

if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return -1
end

redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

function distinctNumbersKey(userId: string, now = new Date()): string {
  const utcDay = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `resolve:d:${userId}:${utcDay}`;
}

function distinctLimitError(): AppError {
  return new AppError(
    'RATE_LIMITED',
    429,
    "You've looked up many different numbers today. Try again tomorrow.",
    { retryAfterSec: 24 * 60 * 60 },
  );
}

async function allowDistinctPhone(userId: string, phoneHash: string): Promise<void> {
  const result = Number(await redis.eval(
    addDistinctPhoneWithinCapLua,
    1,
    distinctNumbersKey(userId),
    phoneHash,
    String(MAX_DISTINCT_NUMBERS_PER_DAY),
    String(DISTINCT_NUMBERS_TTL_SEC),
  ));

  if (result < 0) throw distinctLimitError();
}

export async function resolvePhone(user: AuthUser, rawPhone: string, ipHash: string) {
  const phone = normalizePhone(rawPhone);
  const hash = phoneHmac(phone.e164);

  const [currentUser] = await db.select({ phoneHmac: users.phoneHmac })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!currentUser) throw errors.unauthenticated();
  if (currentUser.phoneHmac === hash) throw errors.selfSend();

  await consume(limits.resolveUserMin, user.id);
  await consume(limits.resolveUserDay, user.id);
  await consume(limits.resolveIpDay, ipHash);
  await allowDistinctPhone(user.id, hash);

  const [recipient] = await db.select({
    address: users.address,
    displayName: users.displayName,
    phoneLinkedAt: users.phoneLinkedAt,
  }).from(users)
    .where(eq(users.phoneHmac, hash))
    .limit(1);

  if (recipient) {
    if (!recipient.phoneLinkedAt) throw errors.internal();

    const [claim] = await db.select({ id: phoneClaims.id })
      .from(phoneClaims)
      .where(and(
        eq(phoneClaims.phoneHmac, hash),
        eq(phoneClaims.status, 'pending_review'),
      ))
      .limit(1);
    const [priorTransfer] = await db.select({ id: transfers.id })
      .from(transfers)
      .where(and(
        eq(transfers.senderUserId, user.id),
        // A payment to a known wallet alone must not identify its phone. Only
        // a confirmed payment already addressed to this phone earns the hint.
        eq(transfers.recipientPhoneHmac, hash),
        eq(transfers.recipientAddress, recipient.address),
        eq(transfers.status, 'confirmed'),
      ))
      .limit(1);

    const registered = {
      status: 'registered' as const,
      phoneMasked: phone.masked,
      recipient: {
        recipientRef: recipientRef(user.address, hash, recipient),
        displayName: recipient.displayName || '',
        underReview: Boolean(claim),
        previouslySentByMe: Boolean(priorTransfer),
      },
    };

    logger.info({ userId: user.id, registered: true }, 'phone resolved');
    return registered;
  }

  const [activeIntents] = await db.select({ total: count() })
    .from(intents)
    .where(and(
      eq(intents.senderUserId, user.id),
      inArray(intents.status, ['pending', 'ready']),
    ));
  const notRegistered = {
    status: 'not_registered' as const,
    phoneMasked: phone.masked,
    canCreateIntent: activeIntents.total < 20,
  };

  logger.info({ userId: user.id, registered: false }, 'phone resolved');
  return notRegistered;
}
