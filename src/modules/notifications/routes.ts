import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { notifications } from '../../db/schema.js';
import { requireAuth } from '../../plugins/auth.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const readBodySchema = z.object({
  ids: z.array(z.uuid()).max(100).optional(),
  all: z.boolean().optional(),
}).strict().refine((body) => !(body.all && body.ids !== undefined), {
  message: 'Provide either ids or all, not both.',
});

const routes: FastifyPluginAsync = async (app) => {
  app.get('/notifications', {
    preHandler: requireAuth,
    schema: { querystring: listQuerySchema },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { limit } = request.query as z.infer<typeof listQuerySchema>;
    const userId = request.user!.id;

    const [items, [unread]] = await Promise.all([
      db.select({
        id: notifications.id,
        type: notifications.type,
        data: notifications.data,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      }).from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(limit),
      db.select({ unreadCount: count() }).from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
    ]);

    return { items, unreadCount: unread.unreadCount };
  });

  app.post('/notifications/read', {
    preHandler: requireAuth,
    schema: { body: readBodySchema },
  }, async (request, reply) => {
    const { ids, all } = request.body as z.infer<typeof readBodySchema>;
    const userId = request.user!.id;
    const unreadForUser = and(eq(notifications.userId, userId), isNull(notifications.readAt));

    if (all) {
      await db.update(notifications).set({ readAt: new Date() }).where(unreadForUser);
    } else if (ids?.length) {
      await db.update(notifications).set({ readAt: new Date() }).where(and(
        unreadForUser,
        inArray(notifications.id, ids),
      ));
    }

    return reply.code(204).send();
  });
};

export default routes;
