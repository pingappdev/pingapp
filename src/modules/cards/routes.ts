import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { consume, limiter } from '../../lib/rateLimit.js';
import { requireAuth, requireFreshAuth } from '../../plugins/auth.js';
import { networkSchema } from './domain.js';
import { cardholderNameSchema, productSchema, profileVersionSchema } from './products.js';
import { armApplePay, getApplePayCode } from './applePay.js';
import { getProfile, saveProfile } from './profile.js';
import { getCard, getCardsConfig, getOperation, getTransactions, issueCard, listCards, revealCard, topupCard } from './service.js';

const idParams = z.object({ id: z.uuid() });
const applePayLimiter = limiter('card_apple_pay_user_10m', 6, 600);
const issueBody = z.object({ product: productSchema, network: networkSchema, requestId: z.uuid(), expectedUserId: z.uuid(), profileUpdatedAt: profileVersionSchema }).strict();
const topupBody = z.object({ amountUsd: z.string().max(32), network: networkSchema, requestId: z.uuid() }).strict();
const historyQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
const profileBody = z.object({ email: z.string().max(320), expectedUserId: z.uuid(), cardholderName: cardholderNameSchema }).strict();

const routes: FastifyPluginAsync = async (app) => {
  app.get('/cards/config', { preHandler: requireAuth }, () => getCardsConfig());
  app.get('/cards/profile', { preHandler: requireAuth }, async (request) => ({ profile: await getProfile(request.user!.id) }));
  app.patch('/cards/profile', { preHandler: requireAuth, schema: { body: profileBody } }, async (request) => ({
    profile: await saveProfile(request.user!.id, request.body as z.infer<typeof profileBody>),
  }));
  app.get('/cards', { preHandler: requireAuth }, async (request) => ({ items: await listCards(request.user!.id) }));
  app.post('/cards/issue', { preHandler: requireAuth, schema: { body: issueBody } }, async (request, reply) => reply.code(202).send({
    operation: await issueCard(request.user!.id, request.body as z.infer<typeof issueBody>),
  }));
  app.get('/cards/operations/:id', { preHandler: requireAuth, schema: { params: idParams } }, async (request) => ({
    operation: await getOperation(request.user!.id, (request.params as z.infer<typeof idParams>).id),
  }));
  app.get('/cards/:id', { preHandler: requireAuth, schema: { params: idParams } }, async (request) => ({
    card: await getCard(request.user!.id, (request.params as z.infer<typeof idParams>).id),
  }));
  app.post('/cards/:id/topups', { preHandler: requireAuth, schema: { params: idParams, body: topupBody } }, async (request, reply) => reply.code(202).send({
    operation: await topupCard(request.user!.id, (request.params as z.infer<typeof idParams>).id, request.body as z.infer<typeof topupBody>),
  }));
  app.get('/cards/:id/transactions', { preHandler: requireAuth, schema: { params: idParams, querystring: historyQuery } }, async (request) => {
    const { limit, cursor } = request.query as z.infer<typeof historyQuery>;
    return getTransactions(request.user!.id, (request.params as z.infer<typeof idParams>).id, limit, cursor);
  });
  // Activation codes are sensitive: arming needs a fresh wallet signature, and neither response is cached.
  app.post('/cards/:id/apple-pay', { preHandler: requireFreshAuth, schema: { params: idParams, body: z.object({}).strict() } }, async (request) => {
    await consume(applePayLimiter, request.user!.id);
    return { applePay: await armApplePay(request.user!.id, (request.params as z.infer<typeof idParams>).id) };
  });
  app.get('/cards/:id/apple-pay', { preHandler: requireAuth, schema: { params: idParams } }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store, max-age=0').header('pragma', 'no-cache');
    return { applePay: await getApplePayCode(request.user!.id, (request.params as z.infer<typeof idParams>).id) };
  });
  app.post('/cards/:id/reveal', { preHandler: requireFreshAuth, schema: { params: idParams } }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store, max-age=0').header('pragma', 'no-cache');
    return revealCard(request.user!.id, (request.params as z.infer<typeof idParams>).id);
  });
};
export default routes;
