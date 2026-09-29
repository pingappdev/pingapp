import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireFreshAuth } from '../../plugins/auth.js';
import { cancelClaim, requestOtp, unlinkPhone, verifyOtp } from './service.js';

const phoneSchema = z.object({ phone: z.string().max(32) }).strict();
const verifySchema = phoneSchema.extend({ code: z.string().regex(/^\d{6}$/) });

const routes: FastifyPluginAsync = async (app) => {
  app.post('/phone/otp', { preHandler: requireAuth, schema: { body: phoneSchema } }, async (request) => {
    const { phone } = request.body as z.infer<typeof phoneSchema>;
    return requestOtp(request.user!.id, request.session!.id, phone, request.ipHash);
  });
  app.post('/phone/verify', { preHandler: requireAuth, schema: { body: verifySchema } }, async (request) => {
    const { phone, code } = request.body as z.infer<typeof verifySchema>;
    return verifyOtp(request.user!.id, request.session!.id, phone, code, request.ipHash);
  });
  app.delete('/phone', { preHandler: requireFreshAuth }, async (request, reply) => {
    await unlinkPhone(request.user!.id, request.session!.id, request.ipHash);
    return reply.code(204).send();
  });
  app.delete('/phone/claim', { preHandler: requireAuth }, async (request, reply) => {
    await cancelClaim(request.user!.id, request.ipHash);
    return reply.code(204).send();
  });
};

export default routes;
