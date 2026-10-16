import { buildApp } from './app.js';
import { config } from './config.js';
import { sql } from './db/client.js';
import { closeQueues } from './lib/queue.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { initializeRouter, routerStartupFailureCategory, stopRouterSigning } from './lib/routerStartup.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App | undefined;
let shutdownRequested = false;
let startupPromise: Promise<void>;
let shutdownPromise: Promise<void> | undefined;
const startupDrainTimeoutMs = 5_000;
const shutdownTimeoutMs = 15_000;


async function start(): Promise<void> {
  await initializeRouter();
  if (shutdownRequested) return;
  app = await buildApp();
  if (shutdownRequested) return;
  await app.listen({ host: '0.0.0.0', port: config.PORT });
}

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
      logger.error({ category: 'shutdown_timeout' }, 'server shutdown exceeded its deadline');
      process.exit(1);
    }, shutdownTimeoutMs);
    const startupSettled = await waitForStartup();
    if (!startupSettled) logger.warn({ category: 'startup_drain_timeout' }, 'server startup did not settle before shutdown cleanup');
    stopRouterSigning();
    try {
      const appResult = app ? await Promise.allSettled([app.close()]) : [];
      app = undefined;
      const resourceResults = await Promise.allSettled([sql.end(), redis.quit(), closeQueues()]);
      const failure = [...appResult, ...resourceResults].find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        logger.error({ category: 'shutdown_error' }, 'server shutdown failed');
        process.exitCode = 1;
      }
    } finally {
      if (startupSettled) clearTimeout(forceExitTimer);
    }
    if (!startupSettled) {
      logger.error({ category: 'startup_drain_timeout' }, 'server could not drain startup before shutdown');
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
  logger.error({ category: routerStartupFailureCategory(error) }, 'server startup failed');
  process.exitCode = 1;
  await shutdown();
});
