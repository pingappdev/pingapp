import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { consume, limiter } from '../../lib/rateLimit.js';
import { requireAuth } from '../../plugins/auth.js';
import { exportCsv, getTransfer, listTransfers, recordTransfer } from './service.js';

const recordLimiter = limiter('transfer_record_user_min', 30, 60);
const bodySchema = z.object({
  txHash: z.string().max(100),
  expectedSenderAddress: z.string().max(100),
  tokenAddress: z.string().max(100),
  amountRaw: z.string().max(78),
  toAddress: z.string().max(100),
  recipientPhone: z.string().max(32).optional(),
  contactId: z.uuid().optional(),
  intentId: z.uuid().optional(),
  routerId: z.string().regex(/^0x[0-9a-f]{64}$/i).optional(),
}).strict();
const directionSchema = z.enum(['all', 'sent', 'received']).default('all');
const listSchema = z.object({
  direction: directionSchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(256).optional(),
});
const exportSchema = z.object({ direction: directionSchema });
const idSchema = z.object({ id: z.uuid() });

const routes: FastifyPluginAsync = async (app) => {
  app.post('/transfers', { preHandler: requireAuth, schema: { body: bodySchema } }, async (request, reply) => {
    await consume(recordLimiter, request.user!.id);
    const result = await recordTransfer(request.user!, request.body as z.infer<typeof bodySchema>);
    const transfer = await getTransfer(request.user!.id, result.row.id);
    return reply.code(result.created ? 201 : 200).send({ transfer });
  });

  app.get('/transfers', { preHandler: requireAuth, schema: { querystring: listSchema } }, async (request) => {
    return listTransfers(request.user!.id, request.query as z.infer<typeof listSchema>);
  });

  // This literal route must precede /transfers/:id.
  app.get('/transfers/export.csv', { preHandler: requireAuth, schema: { querystring: exportSchema } }, async (request, reply) => {
    const { direction } = request.query as z.infer<typeof exportSchema>;
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="pingapp-activity.csv"');
    return reply.send(exportCsv(request.user!.id, direction));
  });

  app.get('/transfers/:id', { preHandler: requireAuth, schema: { params: idSchema } }, async (request) => {
    const { id } = request.params as z.infer<typeof idSchema>;
    return { transfer: await getTransfer(request.user!.id, id) };
  });
};

export default routes;
