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
const DISCOVERY_GRANT_TTL_SEC = 5 * 60;
const DISCOVERY_GRANT_INDEX_TTL_SEC = 2 * DISCOVERY_GRANT_TTL_SEC;

export type PhoneDiscoveryGrant =
  | { version: 1; status: 'registered'; recipientUserId: string; phoneLinkedAt: string }
  | { version: 1; status: 'not_registered' };

export type PhoneMembership =
  | { membershipStatus: 'unknown'; onPingApp: null }
  | { membershipStatus: 'not_registered'; onPingApp: null }
  | { membershipStatus: 'registered'; onPingApp: { displayName: string } };

type CurrentRecipient = {
  id: string;
  displayName: string;
  phoneLinkedAt: Date | null;
};

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

function grantKey(userId: string, phoneHash: string): string {
  return `resolve:grant:${userId}:${phoneHash}`;
}

function grantIndexKey(userId: string): string {
  return `resolve:grant-index:${userId}`;
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

async function applyDiscoveryBudget(userId: string, phoneHash: string, ipHash: string): Promise<void> {
  await consume(limits.resolveUserMin, userId);
  await consume(limits.resolveUserDay, userId);
  await consume(limits.resolveIpDay, ipHash);
  await allowDistinctPhone(userId, phoneHash);
}

function parseGrant(value: string | null): PhoneDiscoveryGrant | null {
  if (!value) return null;
  try {
    const grant = JSON.parse(value) as Record<string, unknown>;
    if (grant.version !== 1) return null;
    if (grant.status === 'not_registered') return { version: 1, status: 'not_registered' };
    if (grant.status === 'registered' && typeof grant.recipientUserId === 'string' &&
      typeof grant.phoneLinkedAt === 'string' && Number.isFinite(Date.parse(grant.phoneLinkedAt))) {
      return {
        version: 1,
        status: 'registered',
        recipientUserId: grant.recipientUserId,
        phoneLinkedAt: new Date(grant.phoneLinkedAt).toISOString(),
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function readGrant(userId: string, phoneHash: string): Promise<PhoneDiscoveryGrant | null> {
  return parseGrant(await redis.get(grantKey(userId, phoneHash)));
}

async function writeGrant(userId: string, phoneHash: string, grant: PhoneDiscoveryGrant): Promise<void> {
  await redis.multi()
    .set(grantKey(userId, phoneHash), JSON.stringify(grant), 'EX', DISCOVERY_GRANT_TTL_SEC)
    .sadd(grantIndexKey(userId), phoneHash)
    .expire(grantIndexKey(userId), DISCOVERY_GRANT_INDEX_TTL_SEC)
    .exec();
}

function grantMatchesRecipient(
  grant: PhoneDiscoveryGrant,
  recipient: Pick<CurrentRecipient, 'id' | 'phoneLinkedAt'> | null,
): boolean {
  if (grant.status === 'not_registered') return recipient === null;
  return Boolean(recipient?.phoneLinkedAt && recipient.id === grant.recipientUserId &&
    recipient.phoneLinkedAt.toISOString() === grant.phoneLinkedAt);
}

function unregisteredOrUnknown(grant: PhoneDiscoveryGrant, currentRecipient: CurrentRecipient | undefined): PhoneMembership {
  if (grant.status === 'not_registered') {
    return currentRecipient
      ? { membershipStatus: 'unknown', onPingApp: null }
      : { membershipStatus: 'not_registered', onPingApp: null };
  }

  if (!currentRecipient || !grantMatchesRecipient(grant, currentRecipient)) {
    return { membershipStatus: 'unknown', onPingApp: null };
  }
  return {
    membershipStatus: 'registered',
    onPingApp: { displayName: currentRecipient.displayName ?? '' },
  };
}

/**
 * Reuses only explicit, short-lived resolve grants. It queries current user
 * bindings for granted phone hashes only, so contact listing never joins every
 * saved number against the user directory.
 */
export async function phoneMembershipsForContacts(
  userId: string,
  contactPhoneHashes: readonly string[],
): Promise<Map<string, PhoneMembership>> {
  const memberships = new Map<string, PhoneMembership>();
  const wanted = new Set(contactPhoneHashes);
  for (const phoneHash of wanted) memberships.set(phoneHash, { membershipStatus: 'unknown', onPingApp: null });
  if (!wanted.size) return memberships;

  const indexedHashes = await redis.smembers(grantIndexKey(userId));
  const relevantHashes = indexedHashes.filter((phoneHash) => wanted.has(phoneHash));
  if (!relevantHashes.length) return memberships;

  const rawGrants = await redis.mget(...relevantHashes.map((phoneHash) => grantKey(userId, phoneHash)));
  const grants = new Map<string, PhoneDiscoveryGrant>();
  const staleIndexEntries: string[] = [];
  for (let index = 0; index < relevantHashes.length; index += 1) {
    const phoneHash = relevantHashes[index];
    const grant = parseGrant(rawGrants[index] ?? null);
    if (grant) grants.set(phoneHash, grant);
    else staleIndexEntries.push(phoneHash);
  }
  if (staleIndexEntries.length) await redis.srem(grantIndexKey(userId), ...staleIndexEntries);
  if (!grants.size) return memberships;

  const currentRows = await db.select({
    phoneHmac: users.phoneHmac,
    id: users.id,
    displayName: users.displayName,
    phoneLinkedAt: users.phoneLinkedAt,
  }).from(users).where(inArray(users.phoneHmac, [...grants.keys()]));
  const currentByHash = new Map<string, CurrentRecipient>();
  for (const current of currentRows) {
    if (current.phoneHmac) currentByHash.set(current.phoneHmac, current);
  }
  for (const [phoneHash, grant] of grants) {
    memberships.set(phoneHash, unregisteredOrUnknown(grant, currentByHash.get(phoneHash)));
  }
  return memberships;
}

/** A send may reveal membership only after the same discovery budgets admit it. */
export async function requirePhoneDiscoveryGrant(
  userId: string,
  phoneHash: string,
  ipHash: string,
): Promise<PhoneDiscoveryGrant> {
  await applyDiscoveryBudget(userId, phoneHash, ipHash);
  const grant = await readGrant(userId, phoneHash);
  if (!grant) {
    throw errors.conflict('Look up this recipient before sending.');
  }
  return grant;
}

export function isPhoneDiscoveryGrantCurrent(
  grant: PhoneDiscoveryGrant,
  recipient: Pick<CurrentRecipient, 'id' | 'phoneLinkedAt'> | null,
): boolean {
  return grantMatchesRecipient(grant, recipient);
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

  await applyDiscoveryBudget(user.id, hash, ipHash);

  const [recipient] = await db.select({
    id: users.id,
    address: users.address,
    displayName: users.displayName,
    phoneLinkedAt: users.phoneLinkedAt,
  }).from(users)
    .where(eq(users.phoneHmac, hash))
    .limit(1);

  if (recipient) {
    if (!recipient.phoneLinkedAt) throw errors.internal();

    const grant: PhoneDiscoveryGrant = {
      version: 1,
      status: 'registered',
      recipientUserId: recipient.id,
      phoneLinkedAt: recipient.phoneLinkedAt.toISOString(),
    };
    await writeGrant(user.id, hash, grant);

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

  await writeGrant(user.id, hash, { version: 1, status: 'not_registered' });
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
