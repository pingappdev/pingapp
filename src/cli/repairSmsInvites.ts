import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { config } from '../config.js';
import { db, sql } from '../db/client.js';
import { escrows } from '../db/schema.js';

const MAX_ROWS = 1000;

type RepairOptions = { apply: boolean; limit: number; ids: string[]; confirmProduction: boolean };

function usage(): string {
  return 'Usage: npx tsx src/cli/repairSmsInvites.ts [--limit N] [--apply --ids ID[,ID...]] [--confirm-production]';
}

function parseIds(value: string): string[] {
  const ids = value.split(',').map((id) => id.trim().toLowerCase());
  if (ids.length === 0 || ids.length > MAX_ROWS || ids.some((id) => !/^0x[0-9a-f]{64}$/.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new Error(`--ids must contain 1 to ${MAX_ROWS} unique 32-byte escrow IDs.`);
  }
  return ids;
}

function parseArgs(args: string[]): RepairOptions {
  let apply = false;
  let limit = MAX_ROWS;
  let limitSpecified = false;
  let ids: string[] = [];
  let confirmProduction = false;
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
      limitSpecified = true;
      i += 1;
      continue;
    }
    if (args[i] === '--ids') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error(usage());
      ids = parseIds(value);
      i += 1;
      continue;
    }
    if (args[i] === '--confirm-production') {
      confirmProduction = true;
      continue;
    }
    throw new Error(usage());
  }
  if (apply && ids.length === 0) throw new Error('--apply requires the reviewed exact candidate list via --ids.');
  if (!apply && ids.length > 0) throw new Error('--ids is valid only with --apply.');
  if (apply && limitSpecified) throw new Error('Use --ids to bound apply mode; --limit is available only for dry-run.');
  if (!apply && confirmProduction) throw new Error('--confirm-production is valid only with --apply.');
  return { apply, limit, ids, confirmProduction };
}

async function main(): Promise<void> {
  const { apply, limit, ids, confirmProduction } = parseArgs(process.argv.slice(2));
  if (apply && config.NODE_ENV === 'production' && !confirmProduction) {
    throw new Error('Production apply requires --confirm-production after reviewing the dry-run candidates.');
  }
  if (confirmProduction && config.NODE_ENV !== 'production') {
    throw new Error('--confirm-production is reserved for NODE_ENV=production.');
  }

  const now = new Date();
  const eligibility = [
    eq(escrows.deliveryMode, 'claim'),
    eq(escrows.status, 'deposited'),
    gt(escrows.expiresAt, now),
    gt(escrows.amountRaw, '0'),
    isNotNull(escrows.depositTxHash),
    inArray(escrows.smsStatus, ['disabled', 'skipped_rate_limit']),
  ];
  if (apply) eligibility.push(inArray(escrows.id, ids));
  const candidates = await db.select({
    id: escrows.id,
    smsStatus: escrows.smsStatus,
  }).from(escrows).where(and(...eligibility)).limit(apply ? ids.length : limit);
  if (apply && candidates.length !== ids.length) {
    throw new Error('One or more reviewed IDs are no longer eligible known-not-sent funded invites; no rows were changed.');
  }

  const repaired: string[] = [];
  if (apply) {
    await db.transaction(async (tx) => {
      for (const row of candidates) {
        const [updated] = await tx.update(escrows).set({
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
        if (!updated) throw new Error('A reviewed row changed before repair; transaction rolled back.');
        repaired.push(updated.id);
      }
    });
  }

  process.stdout.write(`${JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    ...(config.NODE_ENV === 'production' && apply ? { productionConfirmation: true } : {}),
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
