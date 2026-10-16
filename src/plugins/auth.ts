import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { consume, limits } from '../lib/rateLimit.js';

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SEEN_INTERVAL_MS = 5 * 60 * 1000;

export type AuthUser = { id: string; address: string };
export type AuthSession = { id: string; freshUntil: Date | null };
type SessionTokenRequest = Pick<FastifyRequest, 'headers' | 'cookies'>;

// randomToken() produces 32 bytes encoded as unpadded base64url.
export function readSessionToken(request: SessionTokenRequest): { token: string; via: 'bearer' | 'cookie' } | null {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    return match ? { token: match[1], via: 'bearer' } : null;
  }
  const token = request.cookies?.pa_session;
  return token ? { token, via: 'cookie' } : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    session: AuthSession | null;
    sessionVia: 'bearer' | 'cookie' | null;
  }
}

const auth: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateRequest('sessionVia', null);
  app.addHook('onRequest', async (request, reply) => {
    const resolved = readSessionToken(request);
    if (!resolved) return;
    const { token, via } = resolved;

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
    request.sessionVia = via;

    const path = request.url.split('?', 1)[0];
    // Authenticated requests share one budget across cookie and bearer
    // sessions. The RPC relay keeps its separate verified-session budget.
    if (path !== '/health' && !(request.method === 'POST' && path === '/v1/rpc')) {
      await consume(limits.general, row.user.id);
    }
    if (row.session.lastSeenAt.getTime() < now.getTime() - SEEN_INTERVAL_MS &&
        path !== '/v1/auth/logout' && path !== '/v1/auth/verify') {
      const [renewed] = await db.update(sessions).set({
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000),
      }).where(and(
        eq(sessions.id, row.session.id),
        gt(sessions.expiresAt, now),
        lt(sessions.lastSeenAt, new Date(now.getTime() - SEEN_INTERVAL_MS)),
      )).returning({ id: sessions.id });
      if (renewed && via === 'cookie') setSessionCookie(reply, token);
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.user) reply.header('cache-control', 'private, no-store');
    return payload;
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
  reply.header('cache-control', 'private, no-store');
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
  reply.header('cache-control', 'private, no-store');
  reply.clearCookie('pa_session', {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    domain: config.COOKIE_DOMAIN || undefined,
  });
}
