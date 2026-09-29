import { and, desc, eq, gt, ne } from 'drizzle-orm';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { sessions, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { errors } from '../../lib/errors.js';

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
  tx: DbTransaction, userId: string, sessionId: string, options: { lock?: boolean } = {},
): Promise<void> {
  const where = and(
    eq(sessions.id, sessionId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date()),
  );
  const [session] = options.lock
    ? await tx.select({ freshUntil: sessions.freshUntil }).from(sessions).where(where).for('update').limit(1)
    : await tx.select({ freshUntil: sessions.freshUntil }).from(sessions).where(where).limit(1);
  if (!session) throw errors.unauthenticated();
  if (!session.freshUntil || session.freshUntil <= new Date()) throw errors.reauthRequired();
}

export async function revokeOtherSessions(
  userId: string, currentSessionId: string, ipHash: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireFreshSession(tx, userId, currentSessionId, { lock: true });
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
