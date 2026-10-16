import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { config } from '../config.js';
import { db, sql } from '../db/client.js';
import { escrows } from '../db/schema.js';

const MAX_ROWS = 1000;

function parseArgs(args: string[]): { apply: boolean; limit: number } {
  let apply = false;
  let limit = MAX_ROWS;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--apply') {
      apply = true;
      continue;
    }
    if (args[i] === '--limit') {
      const value = Number(args[i + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ROWS) {
        throw new Error(`--limit must be an integer from 1 to ${MAX_ROWS}.`);
      }
      limit = value;
      i += 1;
      continue;
    }
    throw new Error('Usage: npx tsx src/cli/repairSmsInvites.ts [--limit N] [--apply]');
  }
  return { apply, limit };
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  if (apply && config.NODE_ENV === 'production') {
    throw new Error('Historical SMS repair is blocked in production.');
  }

  const now = new Date();
  const candidates = await db.select({
    id: escrows.id,
    smsStatus: escrows.smsStatus,
  }).from(escrows).where(and(
    eq(escrows.deliveryMode, 'claim'),
    eq(escrows.status, 'deposited'),
    gt(escrows.expiresAt, now),
    gt(escrows.amountRaw, '0'),
    isNotNull(escrows.depositTxHash),
    inArray(escrows.smsStatus, ['disabled', 'skipped_rate_limit']),
  )).limit(limit);

  const repaired: string[] = [];
  if (apply) {
    for (const row of candidates) {
      const [updated] = await db.update(escrows).set({
        smsStatus: row.smsStatus === 'skipped_rate_limit' ? 'deferred_rate_limit' : 'deferred_budget',
        smsNextAttemptAt: now,
      }).where(and(
        eq(escrows.id, row.id),
        eq(escrows.deliveryMode, 'claim'),
        eq(escrows.status, 'deposited'),
        gt(escrows.expiresAt, now),
        gt(escrows.amountRaw, '0'),
        isNotNull(escrows.depositTxHash),
        inArray(escrows.smsStatus, ['disabled', 'skipped_rate_limit']),
      )).returning({ id: escrows.id });
      if (updated) repaired.push(updated.id);
    }
  }

  process.stdout.write(`${JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    evidence: 'legacy disabled/skipped_rate_limit outcomes are recorded before provider invocation',
    candidateCount: candidates.length,
    candidates: candidates.map((row) => ({
      id: row.id,
      previousStatus: row.smsStatus,
      proposedStatus: row.smsStatus === 'skipped_rate_limit' ? 'deferred_rate_limit' : 'deferred_budget',
    })),
    repairedCount: repaired.length,
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'repair tool failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
