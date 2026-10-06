import type { WorkerCtx } from '../../lib/modules.js';
import { runCardsMaintenance } from './reconcile.js';

export default async function registerJobs(ctx: WorkerCtx) {
  ctx.process('cards', 'reconcile', async () => {
    try { await runCardsMaintenance(); }
    catch { ctx.logger.warn('Card reconciliation deferred; durable work will be retried.'); }
  });
  await ctx.schedule('cards', 'reconcile', 10_000);
}
