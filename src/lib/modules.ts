import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';
import type { Job } from 'bullmq';
import type { QueueName } from './queue.js';

const modulesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules');

async function moduleFiles(fileBase: string): Promise<string[]> {
  const folders = (await readdir(modulesPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const files: string[] = [];
  for (const folder of folders) {
    for (const extension of ['js', 'ts']) {
      const path = join(modulesPath, folder, `${fileBase}.${extension}`);
      try {
        if ((await stat(path)).isFile()) {
          files.push(path);
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return files;
}

export async function loadRouteModules(app: FastifyInstance): Promise<void> {
  for (const path of await moduleFiles('routes')) {
    const mod = await import(pathToFileURL(path).href) as { default: FastifyPluginAsync; prefix?: string };
    app.register(mod.default, { prefix: mod.prefix ?? '/v1' });
  }
}

export type WorkerCtx = {
  logger: Logger;
  process(queue: QueueName, jobName: string, handler: (job: Job) => Promise<unknown>): void;
  schedule(queue: QueueName, jobName: string, everyMs: number, data?: unknown): Promise<void>;
};

export async function loadJobModules(ctx: WorkerCtx): Promise<void> {
  for (const path of await moduleFiles('jobs')) {
    const mod = await import(pathToFileURL(path).href) as { default: (context: WorkerCtx) => Promise<void> | void };
    await mod.default(ctx);
  }
}
