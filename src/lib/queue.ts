import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedis } from './redis.js';

export const QUEUES = {
  transfers: 'transfers',
  intents: 'intents',
  tokens: 'tokens',
  maintenance: 'maintenance',
} as const;

export type QueueName = keyof typeof QUEUES;

const defaultJobOptions: JobsOptions = {
  removeOnComplete: 1000,
  removeOnFail: 5000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

const queues = new Map<QueueName, Queue>();
const queueConnections = new Map<QueueName, Redis>();

export function getQueue(name: QueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const connection = createRedis();
  const queue = new Queue(QUEUES[name], {
    connection,
    defaultJobOptions,
  });
  queues.set(name, queue);
  queueConnections.set(name, connection);
  return queue;
}

export async function enqueue(name: QueueName, jobName: string, data: unknown, opts?: JobsOptions) {
  return getQueue(name).add(jobName, data, opts);
}

export async function closeQueues(): Promise<void> {
  const closing = [...queues.entries()];
  queues.clear();
  const closeResults = await Promise.allSettled(closing.map(([, queue]) => queue.close()));
  const connections = closing.flatMap(([name]) => {
    const connection = queueConnections.get(name);
    queueConnections.delete(name);
    return connection ? [connection] : [];
  });
  const quitResults = await Promise.allSettled(connections.map((connection) => connection.quit()));
  const failure = [...closeResults, ...quitResults].find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
