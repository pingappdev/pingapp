import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { serializeMe } from './serialize.js';
import {
  deleteAccount,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  updateDisplayName,
} from './service.js';
import { clearSessionCookie, requireAuth, requireFreshAuth } from '../../plugins/auth.js';

const profileSchema = z.object({ displayName: z.string().max(1000) });
const sessionParamsSchema = z.object({ id: z.string().uuid() });

const routes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: requireAuth }, async (request) => ({
    me: await serializeMe(request.user!.id, request.session!.id),
  }));

  app.patch('/me', { preHandler: requireAuth, schema: { body: profileSchema } }, async (request) => {
    const { displayName } = request.body as z.infer<typeof profileSchema>;
    await updateDisplayName(request.user!.id, displayName, request.ipHash);
    return { me: await serializeMe(request.user!.id, request.session!.id) };
  });

  app.get('/me/sessions', { preHandler: requireAuth }, async (request) => ({
    items: await listSessions(request.user!.id, request.session!.id),
  }));

  app.delete('/me/sessions/:id', {
    preHandler: requireAuth,
    schema: { params: sessionParamsSchema },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof sessionParamsSchema>;
    await revokeSession(request.user!.id, id, request.ipHash);
    if (id === request.session!.id) clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post('/me/sessions/revoke-others', { preHandler: requireFreshAuth }, async (request, reply) => {
    await revokeOtherSessions(request.user!.id, request.session!.id, request.ipHash);
    return reply.code(204).send();
  });

  app.delete('/me', { preHandler: requireFreshAuth }, async (request, reply) => {
    await deleteAccount(request.user!.id, request.session!.id, request.ipHash);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
};

export default routes;
