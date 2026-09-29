import { Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { loadJobModules, type WorkerCtx } from './lib/modules.js';
import { closeQueues, getQueue, QUEUES, type QueueName } from './lib/queue.js';
import { logger } from './lib/logger.js';
import { createRedis, redis } from './lib/redis.js';

type Processor = (job: Job) => Promise<unknown>;
const processors = new Map<QueueName, Map<string, Processor>>();
const workers: Worker[] = [];

const ctx: WorkerCtx = {
  logger,
  process(queue, jobName, handler) {
    let queueProcessors = processors.get(queue);
    if (!queueProcessors) {
      queueProcessors = new Map();
      processors.set(queue, queueProcessors);
    }
    if (queueProcessors.has(jobName)) {
      throw new Error(`Duplicate processor registered for ${queue}:${jobName}`);
    }
    queueProcessors.set(jobName, handler);
  },
  async schedule(queue, jobName, everyMs, data) {
    await getQueue(queue).upsertJobScheduler(jobName, { every: everyMs }, { name: jobName, data });
  },
};

async function start(): Promise<void> {
  await loadJobModules(ctx);

  for (const [queueName, handlers] of processors) {
    const worker = new Worker(QUEUES[queueName], async (job) => {
      const handler = handlers.get(job.name);
      if (!handler) throw new Error(`No processor registered for ${queueName}:${job.name}`);
      return handler(job);
    }, { connection: createRedis(), concurrency: 5 });
    worker.on('failed', (job, error) => {
      logger.error({ jobName: job?.name, jobId: job?.id, error: error.message }, 'queue job failed');
    });
    worker.on('error', (error) => logger.error({ err: error }, 'worker connection error'));
    workers.push(worker);
  }

  await Promise.all(workers.map((worker) => worker.waitUntilReady()));
  logger.info('worker started');
}

await start();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const results = await Promise.allSettled([
    ...workers.map((worker) => worker.close()),
    closeQueues(),
    redis.quit(),
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    logger.error({ err: failure.reason }, 'worker shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
