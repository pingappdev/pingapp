import type { WorkerCtx } from '../../lib/modules.js';

export default async function registerJobs(ctx: WorkerCtx): Promise<void> {
  ctx.process('maintenance', 'heartbeat', async () => {
    ctx.logger.debug('worker heartbeat');
  });
  await ctx.schedule('maintenance', 'heartbeat', 5 * 60 * 1000);
}
