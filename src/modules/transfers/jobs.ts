import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { transfers } from '../../db/schema.js';
import type { WorkerCtx } from '../../lib/modules.js';
import { enqueue, getQueue } from '../../lib/queue.js';
import { confirmTransfer } from './service.js';

const MINUTE = 60_000;
const SWEEP_BATCH = 500;

export default async function registerJobs(ctx: WorkerCtx): Promise<void> {
  ctx.process('transfers', 'confirm', async (job) => {
    const data = job.data as { transferId?: unknown; attempt?: unknown };
    if (typeof data.transferId !== 'string' || typeof data.attempt !== 'number' ||
        !Number.isSafeInteger(data.attempt) || data.attempt < 0) return;
    await confirmTransfer(data.transferId, data.attempt);
  });

  ctx.process('transfers', 'sweep', async () => {
    const now = Date.now();
    await db.update(transfers).set({ status: 'not_found' }).where(and(
      eq(transfers.status, 'submitted'), lt(transfers.createdAt, new Date(now - 35 * MINUTE)),
    ));

    // Jobs can be lost between the DB insert and BullMQ enqueue, or after a
    // worker crash. Inspect only active queue states and enqueue a unique sweep
    // probe for submitted rows with no pending confirmation.
    const queue = getQueue('transfers');
    const pending = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);
    const queuedIds = new Set(pending.filter((job) => job.name === 'confirm')
      .map((job) => (job.data as { transferId?: unknown }).transferId).filter((id): id is string => typeof id === 'string'));
    let lastId = '';
    for (;;) {
      const rows = await db.select({ id: transfers.id }).from(transfers).where(and(
        eq(transfers.status, 'submitted'),
        lt(transfers.createdAt, new Date(now - MINUTE)),
        gt(transfers.createdAt, new Date(now - 35 * MINUTE)),
        gt(transfers.id, lastId),
      )).orderBy(transfers.id).limit(SWEEP_BATCH);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (queuedIds.has(row.id)) continue;
        await enqueue('transfers', 'confirm', { transferId: row.id, attempt: 0 }, {
          jobId: `confirm-${row.id}-sweep-${Math.floor(now / MINUTE)}`,
        });
      }
      lastId = rows[rows.length - 1].id;
    }
  });
  await ctx.schedule('transfers', 'sweep', 10 * MINUTE);
}
