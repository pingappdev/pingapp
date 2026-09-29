import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { consume, limits } from '../../lib/rateLimit.js';
import { requireAuth } from '../../plugins/auth.js';
import { cancelIntent, createIntent, getClaim, listIncoming, listIntents } from './service.js';

const createSchema = z.object({
  phone: z.string().max(32),
  tokenAddress: z.string().max(100),
  amount: z.string().max(100),
  note: z.string().max(1000).optional(),
}).strict();
const listSchema = z.object({ status: z.enum(['open', 'all']).default('open') }).strict();
const idSchema = z.object({ id: z.uuid() });

const routes: FastifyPluginAsync = async (app) => {
  app.post('/intents', {
    preHandler: requireAuth,
    schema: { body: createSchema },
  }, async (request, reply) => {
    const intent = await createIntent(
      request.user!.id,
      request.body as z.infer<typeof createSchema>,
      request.ipHash,
    );
    return reply.code(201).send({ intent });
  });

  app.get('/intents', {
    preHandler: requireAuth,
    schema: { querystring: listSchema },
  }, async (request) => {
    const { status } = request.query as z.infer<typeof listSchema>;
    return { items: await listIntents(request.user!.id, status) };
  });

  // Register this literal route before /intents/:id/cancel.
  app.get('/intents/incoming', { preHandler: requireAuth }, async (request) => {
    return { items: await listIncoming(request.user!.id) };
  });

  app.post('/intents/:id/cancel', {
    preHandler: requireAuth,
    schema: { params: idSchema },
  }, async (request) => {
    const { id } = request.params as z.infer<typeof idSchema>;
    return { intent: await cancelIntent(request.user!.id, id, request.ipHash) };
  });

  app.get('/claims/:code', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const { code } = request.params as { code: string };
    if (!/^[0-9A-Za-z]{10}$/.test(code)) throw errors.notFound();
    await consume(limits.claimsIpHour, request.ipHash);
    return getClaim(code);
  });
};

export default routes;
