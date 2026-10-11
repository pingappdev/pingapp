import { buildApp } from './app.js';
import { config } from './config.js';
import { sql } from './db/client.js';
import { closeQueues } from './lib/queue.js';
import { redis } from './lib/redis.js';
import { initializeRouter } from './lib/routerStartup.js';

await initializeRouter();
const app = await buildApp();
await app.listen({ host: '0.0.0.0', port: config.PORT });

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    const results = await Promise.allSettled([sql.end(), redis.quit(), closeQueues()]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
