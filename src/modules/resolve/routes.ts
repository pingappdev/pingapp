import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { resolvePhone } from './service.js';

const resolveSchema = z.object({ phone: z.string().max(32) }).strict();

const routes: FastifyPluginAsync = async (app) => {
  app.post('/resolve', {
    preHandler: requireAuth,
    schema: { body: resolveSchema },
  }, async (request) => {
    const { phone } = request.body as z.infer<typeof resolveSchema>;
    return resolvePhone(request.user!, phone, request.ipHash);
  });
};

export default routes;
