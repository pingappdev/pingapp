import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { audit } from '../../db/audit.js';
import { sessions } from '../../db/schema.js';
import { consume, limiter } from '../../lib/rateLimit.js';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../../plugins/auth.js';
import { serializeMe } from '../me/serialize.js';
import { createNonce, LOGIN_STATEMENT, login, REAUTH_STATEMENT, refreshFreshAuth, verifySiwe } from './service.js';

const nonceLimiter = limiter('siwe_nonce_ip', 30, 60);
const bodySchema = z.object({
  message: z.string().max(2000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(20_000),
});

const routes: FastifyPluginAsync = async (app) => {
  app.get('/auth/nonce', async (request) => {
    await consume(nonceLimiter, request.ipHash);
    return { nonce: await createNonce() };
  });

  app.post('/auth/verify', { schema: { body: bodySchema } }, async (request, reply) => {
    const { message, signature } = request.body as z.infer<typeof bodySchema>;
    const address = await verifySiwe(message, signature as `0x${string}`, { expectedStatement: LOGIN_STATEMENT });
    const { token, user, sessionId } = await login(address, {
      userAgent: request.headers['user-agent'],
      ipHash: request.ipHash,
    });
    const me = await serializeMe(user.id, sessionId);
    setSessionCookie(reply, token);
    return { me };
  });

  app.get('/auth/session', { preHandler: requireAuth }, async (request) => ({
    me: await serializeMe(request.user!.id, request.session!.id),
  }));

  app.post('/auth/reauth', { preHandler: requireAuth, schema: { body: bodySchema } }, async (request) => {
    const { message, signature } = request.body as z.infer<typeof bodySchema>;
    await verifySiwe(message, signature as `0x${string}`, {
      expectedAddress: request.user!.address,
      expectedStatement: REAUTH_STATEMENT,
    });
    const freshUntil = await refreshFreshAuth(request.session!.id, request.user!.id, request.ipHash);
    request.session!.freshUntil = freshUntil;
    return { freshUntil: freshUntil.toISOString() };
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.session && request.user) {
      await db.transaction(async (tx) => {
        const [deleted] = await tx.delete(sessions)
          .where(and(eq(sessions.id, request.session!.id), eq(sessions.userId, request.user!.id)))
          .returning({ id: sessions.id });
        if (deleted) {
          await audit('session_revoked', {
            userId: request.user!.id,
            data: { sessionId: deleted.id, reason: 'logout' },
            ipHash: request.ipHash,
          }, tx);
        }
      });
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
};

export default routes;
