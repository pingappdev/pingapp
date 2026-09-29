import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { intents, phoneClaims, sessions, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { sha256Hex } from '../../lib/crypto.js';
import { errors } from '../../lib/errors.js';
import { lockPhoneMutation } from '../phone/lock.js';

const DISALLOWED_NAME_PARTS = [
  'http', 'www', '.com', 'pingapp', 'robinhood', 'support', 'admin', 'official',
];
const USER_AGENT_LIMIT = 200;

export function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function validateDisplayName(value: string): string {
  const displayName = normalizeDisplayName(value);
  const lowerName = displayName.toLowerCase();
  if (DISALLOWED_NAME_PARTS.some((part) => lowerName.includes(part))) {
    throw errors.validation('Please choose a different name.');
  }
  if (!/^[\p{L}\p{N} .'_-]{1,40}$/u.test(displayName)) {
    throw errors.validation('Use 1–40 letters, numbers, spaces, or . - _ \'.');
  }
  return displayName;
}

export async function updateDisplayName(userId: string, value: string, ipHash: string): Promise<void> {
  const displayName = validateDisplayName(value);
  await db.transaction(async (tx) => {
    const [user] = await tx.select({ displayName: users.displayName }).from(users)
      .where(eq(users.id, userId)).for('update').limit(1);
    if (!user) throw errors.unauthenticated();
    if (user.displayName === displayName) return;

    await tx.update(users).set({ displayName }).where(eq(users.id, userId));
    await audit('display_name_changed', { userId, ipHash }, tx);
  });
}

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await db.select({
    id: sessions.id,
    createdAt: sessions.createdAt,
    lastSeenAt: sessions.lastSeenAt,
    userAgent: sessions.userAgent,
  }).from(sessions).where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.lastSeenAt));

  return rows.map((session) => ({
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    userAgent: session.userAgent?.slice(0, USER_AGENT_LIMIT) ?? '',
    current: session.id === currentSessionId,
  }));
}

export async function revokeSession(userId: string, sessionId: string, ipHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [deleted] = await tx.delete(sessions).where(and(
      eq(sessions.id, sessionId), eq(sessions.userId, userId),
    )).returning({ id: sessions.id });
    if (!deleted) throw errors.notFound();
    await audit('session_revoked', {
      userId,
      data: { sessionId: deleted.id },
      ipHash,
    }, tx);
  });
}

async function requireFreshSession(
  tx: DbTransaction, userId: string, sessionId: string,
): Promise<void> {
  const where = and(
    eq(sessions.id, sessionId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date()),
  );
  const [session] = await tx.select({ freshUntil: sessions.freshUntil }).from(sessions)
    .where(where).for('update').limit(1);
  if (!session) throw errors.unauthenticated();
  if (!session.freshUntil || session.freshUntil <= new Date()) throw errors.reauthRequired();
}

export async function revokeOtherSessions(
  userId: string, currentSessionId: string, ipHash: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireFreshSession(tx, userId, currentSessionId);
    const revoked = await tx.delete(sessions).where(and(
      eq(sessions.userId, userId), ne(sessions.id, currentSessionId),
    )).returning({ id: sessions.id });
    await audit('session_revoked', {
      userId,
      data: { reason: 'revoke_others', count: revoked.length, sessionIds: revoked.map(({ id }) => id) },
      ipHash,
    }, tx);
  });
}

export async function deleteAccount(userId: string, currentSessionId: string, ipHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    // This global lock must be acquired before touching any user, claim, or
    // intent rows so deletion follows the BE-11 phone mutation lock order.
    await lockPhoneMutation(tx);
    await requireFreshSession(tx, userId, currentSessionId);

    const [user] = await tx.select({ address: users.address }).from(users)
      .where(eq(users.id, userId)).for('update').limit(1);
    if (!user) throw errors.unauthenticated();

    await tx.update(intents).set({ status: 'cancelled' }).where(and(
      eq(intents.senderUserId, userId), inArray(intents.status, ['pending', 'ready']),
    ));
    await tx.update(intents).set({ status: 'pending', recipientUserId: null, readyAt: null }).where(and(
      eq(intents.recipientUserId, userId), eq(intents.status, 'ready'),
    ));
    await tx.update(phoneClaims).set({ status: 'cancelled', resolvedAt: new Date() }).where(and(
      eq(phoneClaims.claimantUserId, userId), eq(phoneClaims.status, 'pending_review'),
    ));

    await tx.delete(users).where(eq(users.id, userId));
    await audit('account_deleted', {
      userId: null,
      data: { addressHash: sha256Hex(user.address) },
      ipHash,
    }, tx);
  });
}
