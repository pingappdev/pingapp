import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { create, list, remove, update } from './service.js';

const inputSchema = z.object({
  name: z.string().max(1000).optional(),
  phone: z.string().max(32).optional(),
}).strict();
const paramsSchema = z.object({ id: z.string().uuid() }).strict();

const routes: FastifyPluginAsync = async (app) => {
  app.get('/contacts', { preHandler: requireAuth }, async (request) => ({
    items: await list(request.user!.id),
  }));

  app.post('/contacts', {
    preHandler: requireAuth,
    schema: { body: inputSchema },
  }, async (request, reply) => {
    const contact = await create(request.user!.id, request.body as z.infer<typeof inputSchema>);
    return reply.code(201).send({ contact });
  });

  app.patch('/contacts/:id', {
    preHandler: requireAuth,
    schema: { params: paramsSchema, body: inputSchema },
  }, async (request) => {
    const { id } = request.params as z.infer<typeof paramsSchema>;
    const contact = await update(request.user!.id, id, request.body as z.infer<typeof inputSchema>);
    return { contact };
  });

  app.delete('/contacts/:id', {
    preHandler: requireAuth,
    schema: { params: paramsSchema },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof paramsSchema>;
    await remove(request.user!.id, id);
    return reply.code(204).send();
  });
};

export default routes;
