import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SEEN_INTERVAL_MS = 5 * 60 * 1000;

export type AuthUser = { id: string; address: string };
export type AuthSession = { id: string; freshUntil: Date | null };

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    session: AuthSession | null;
  }
}

const auth: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (request) => {
    const token = request.cookies.pa_session;
    if (!token) return;

    const now = new Date();
    const [row] = await db.select({
      session: sessions,
      user: { id: users.id, address: users.address },
    }).from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, now)))
      .limit(1);
    if (!row) return;

    request.user = row.user;
    request.session = { id: row.session.id, freshUntil: row.session.freshUntil };

    if (row.session.lastSeenAt.getTime() < now.getTime() - SEEN_INTERVAL_MS) {
      await db.update(sessions).set({
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000),
      }).where(and(
        eq(sessions.id, row.session.id),
        gt(sessions.expiresAt, now),
        lt(sessions.lastSeenAt, new Date(now.getTime() - SEEN_INTERVAL_MS)),
      ));
    }
  });
};

export default fp(auth, { name: 'auth' });

export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (!request.user || !request.session) {
    throw new AppError('UNAUTHENTICATED', 401, 'Please sign in with your wallet.');
  }
}

export async function requireFreshAuth(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  if (!request.session!.freshUntil || request.session!.freshUntil <= new Date()) {
    throw new AppError('REAUTH_REQUIRED', 403, 'Please confirm this action in your wallet.');
  }
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie('pa_session', token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    domain: config.COOKIE_DOMAIN || undefined,
    maxAge: SESSION_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie('pa_session', {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    domain: config.COOKIE_DOMAIN || undefined,
  });
}
