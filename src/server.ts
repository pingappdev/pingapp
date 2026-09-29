import { buildApp } from './app.js';
import { config } from './config.js';
import { sql } from './db/client.js';
import { redis } from './lib/redis.js';

const app = await buildApp();
await app.listen({ host: '0.0.0.0', port: config.PORT });

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await Promise.all([sql.end(), redis.quit()]);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
