import type { FastifyPluginAsync } from 'fastify';
import { sql } from '../../db/client.js';
import { redis } from '../../lib/redis.js';

export const prefix = '';

async function withinTwoSeconds<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('health timeout')), 2_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const routes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_request, reply) => {
    const [db, cache] = await Promise.all([
      withinTwoSeconds(sql`select 1`).then(() => true, () => false),
      withinTwoSeconds(redis.ping()).then(() => true, () => false),
    ]);
    if (!db || !cache) reply.code(503);
    return { ok: db && cache, db, redis: cache };
  });
};

export default routes;
