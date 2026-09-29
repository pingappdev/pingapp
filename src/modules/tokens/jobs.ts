import { enqueue } from '../../lib/queue.js';
import type { WorkerCtx } from '../../lib/modules.js';
import { syncStockTokens, syncWellKnown } from './registry.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export default async function registerJobs(ctx: WorkerCtx): Promise<void> {
  ctx.process('tokens', 'sync', async () => {
    await syncWellKnown();
    await syncStockTokens();
  });
  await ctx.schedule('tokens', 'sync', SIX_HOURS_MS);
  await enqueue('tokens', 'sync', { source: 'boot' }, { jobId: 'tokens-sync-boot' });
}
