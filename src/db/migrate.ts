import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const migrationsFolder = resolve(process.cwd(), 'drizzle');
let client: ReturnType<typeof postgres> | undefined;

try {
  const entries = await readdir(migrationsFolder);
  if (entries.some((entry) => entry.endsWith('.sql'))) {
    client = postgres(config.DATABASE_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder });
    logger.info('database migrations applied');
  } else {
    logger.info('no database migrations to apply');
  }
} catch (error) {
  logger.error({ err: error }, 'database migration failed');
  process.exitCode = 1;
} finally {
  await client?.end();
}
