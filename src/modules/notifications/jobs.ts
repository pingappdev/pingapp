import { lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { notifications } from '../../db/schema.js';
import type { WorkerCtx } from '../../lib/modules.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * DAY_MS;

export default async function registerJobs(ctx: WorkerCtx): Promise<void> {
  ctx.process('maintenance', 'notifications-prune', async () => {
    const cutoff = new Date(Date.now() - NINETY_DAYS_MS);
    await db.delete(notifications).where(lt(notifications.createdAt, cutoff));
  });

  await ctx.schedule('maintenance', 'notifications-prune', DAY_MS);
}
