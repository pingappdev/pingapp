import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { consume, limiter } from '../../lib/rateLimit.js';
import { requireAuth } from '../../plugins/auth.js';
import { claimEscrow, listEscrows, submittedEscrow } from './service.js';

const mutationLimiter = limiter('escrow_user_min', 30, 60);
const idSchema = z.object({ id: z.string().regex(/^0x[0-9a-f]{64}$/i).transform((value) => value.toLowerCase()) });
const submittedSchema = z.object({ txHash: z.string().regex(/^0x[0-9a-f]{64}$/i).transform((value) => value.toLowerCase()) }).strict();
const listSchema = z.object({ role: z.enum(['sent', 'incoming']).default('sent') }).strict();
const routes: FastifyPluginAsync = async (app) => {
  app.post('/escrows/:id/submitted', { preHandler: requireAuth, schema: { params: idSchema, body: submittedSchema } }, async (request) => {
    await consume(mutationLimiter, request.user!.id);
    return { escrow: await submittedEscrow(request.user!, (request.params as z.infer<typeof idSchema>).id,
      (request.body as z.infer<typeof submittedSchema>).txHash) };
  });
  app.post('/escrows/:id/claim', { preHandler: requireAuth, schema: { params: idSchema, body: z.object({}).strict() } }, async (request, reply) => {
    await consume(mutationLimiter, request.user!.id);
    return reply.code(202).send({ escrow: await claimEscrow(request.user!, (request.params as z.infer<typeof idSchema>).id, request.ipHash) });
  });
  app.get('/escrows', { preHandler: requireAuth, schema: { querystring: listSchema } }, async (request) => {
    return { items: await listEscrows(request.user!.id, (request.query as z.infer<typeof listSchema>).role) };
  });
};
export default routes;
