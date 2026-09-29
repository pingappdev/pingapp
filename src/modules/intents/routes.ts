import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { createIntent } from './service.js';

const createSchema = z.object({
  phone: z.string().max(32),
  tokenAddress: z.string().max(100),
  amount: z.string().max(100),
  note: z.string().max(1000).optional(),
}).strict();

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
};

export default routes;
