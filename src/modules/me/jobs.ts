import { lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import type { WorkerCtx } from '../../lib/modules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function registerJobs(ctx: WorkerCtx): Promise<void> {
  ctx.process('maintenance', 'sessions-cleanup', async () => {
    await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  });

  await ctx.schedule('maintenance', 'sessions-cleanup', DAY_MS);
}
