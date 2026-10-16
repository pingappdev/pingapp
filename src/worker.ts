import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { sql } from './db/client.js';
import { loadJobModules, type WorkerCtx } from './lib/modules.js';
import { closeQueues, getQueue, QUEUES, type QueueName } from './lib/queue.js';
import { logger } from './lib/logger.js';
import { createRedis, redis } from './lib/redis.js';
import { initializeRouter, routerStartupFailureCategory, stopRouterSigning } from './lib/routerStartup.js';

type Processor = (job: Job) => Promise<unknown>;
const processors = new Map<QueueName, Map<string, Processor>>();
const workers: Worker[] = [];
const workerConnections: Redis[] = [];
const startupDrainTimeoutMs = 5_000;
const shutdownTimeoutMs = 15_000;

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
  await initializeRouter();
  if (shutdownRequested) return;
  await loadJobModules(ctx);
  if (shutdownRequested) return;

  for (const [queueName, handlers] of processors) {
    const connection = createRedis();
    workerConnections.push(connection);
    const worker = new Worker(QUEUES[queueName], async (job) => {
      const handler = handlers.get(job.name);
      if (!handler) throw new Error(`No processor registered for ${queueName}:${job.name}`);
      return handler(job);
    }, { connection, concurrency: queueName === 'escrows' ? 1 : 5 });
    worker.on('failed', (job, error) => {
      logger.error({ jobName: job?.name, jobId: job?.id, errorName: error.name }, 'queue job failed');
    });
    worker.on('error', (error) => logger.error({ errorName: error.name }, 'worker connection error'));
    workers.push(worker);
  }

  await Promise.all(workers.map((worker) => worker.waitUntilReady()));
  if (shutdownRequested) return;
  logger.info('worker started');
}

let shutdownRequested = false;
let startupPromise: Promise<void>;
let shutdownPromise: Promise<void> | undefined;

async function waitForStartup(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), startupDrainTimeoutMs);
  });
  const completed = startupPromise.then(() => true, () => true);
  const settled = await Promise.race([completed, timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

function shutdown(): Promise<void> {
  shutdownRequested = true;
  shutdownPromise ??= (async () => {
    stopRouterSigning();
    const forceExitTimer = setTimeout(() => {
      logger.error({ category: 'shutdown_timeout' }, 'worker shutdown exceeded its deadline');
      process.exit(1);
    }, shutdownTimeoutMs);
    const startupSettled = await waitForStartup();
    if (!startupSettled) logger.warn({ category: 'startup_drain_timeout' }, 'worker startup did not settle before shutdown cleanup');
    stopRouterSigning();
    try {
      const results: PromiseSettledResult<unknown>[] = [];
      results.push(...await Promise.allSettled(workers.map((worker) => worker.close())));
      results.push(...await Promise.allSettled([closeQueues()]));
      results.push(...await Promise.allSettled(workerConnections.map((connection) => connection.quit())));
      results.push(...await Promise.allSettled([sql.end(), redis.quit()]));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        logger.error({ category: 'shutdown_error' }, 'worker shutdown failed');
        process.exitCode = 1;
      }
    } finally {
      if (startupSettled) clearTimeout(forceExitTimer);
    }
    if (!startupSettled) {
      logger.error({ category: 'startup_drain_timeout' }, 'worker could not drain startup before shutdown');
      process.exit(1);
    }
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
startupPromise = start();
startupPromise.catch(async (error: unknown) => {
  stopRouterSigning();
  logger.error({ category: routerStartupFailureCategory(error) }, 'worker startup failed');
  process.exitCode = 1;
  await shutdown();
});
