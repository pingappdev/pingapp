import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { consume, limiter } from '../../lib/rateLimit.js';
import { requireAuth } from '../../plugins/auth.js';
import { authorizeSend } from './service.js';

const authorizeLimiter = limiter('send_authorize_user_min', 30, 60);
const bodySchema = z.object({
  phone: z.string().max(32),
  tokenAddress: z.string().max(100),
  amount: z.string().max(100),
  expectedSenderAddress: z.string().max(100),
  expectedRecipientRef: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  contactId: z.uuid().optional(),
  note: z.string().max(1000).optional(),
}).strict();

const routes: FastifyPluginAsync = async (app) => {
  app.post('/sends/authorize', { preHandler: requireAuth, schema: { body: bodySchema } }, async (request) => {
    await consume(authorizeLimiter, request.user!.id);
    return authorizeSend(request.user!, request.body as z.infer<typeof bodySchema>, request.ipHash);
  });
};
export default routes;
