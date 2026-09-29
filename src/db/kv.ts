import { eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import { kv } from './schema.js';
import type { DbOrTx } from './tx.js';

export async function kvGet<T>(key: string, tx: DbOrTx = db): Promise<T | undefined> {
  const [row] = await tx.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).limit(1);
  return row ? row.value as T : undefined;
}

export async function kvSet<T>(key: string, value: T, tx: DbOrTx = db): Promise<void> {
  await tx.insert(kv).values({ key, value }).onConflictDoUpdate({
    target: kv.key,
    set: { value, updatedAt: sql`now()` },
  });
}
