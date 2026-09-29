import { logger } from './lib/logger.js';
import { loadJobModules } from './lib/modules.js';
import { redis } from './lib/redis.js';

await loadJobModules({ logger });
logger.info('worker started');
const keepAlive = setInterval(() => {}, 60_000);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(keepAlive);
  await redis.quit();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
