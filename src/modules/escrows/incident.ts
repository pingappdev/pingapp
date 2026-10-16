import { eq, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { kv } from '../../db/schema.js';
import type { DbOrTx } from '../../db/tx.js';
import { AppError, errors } from '../../lib/errors.js';

export type RouterOperation = 'authorizations' | 'claim-signatures' | 'relay-broadcasts';
export type RouterStopState = Record<RouterOperation, boolean>;

const stopKeys: Record<RouterOperation, string> = {
  authorizations: 'router:incident:stop:authorizations',
  'claim-signatures': 'router:incident:stop:claim-signatures',
  'relay-broadcasts': 'router:incident:stop:relay-broadcasts',
};
const lockIds: Record<RouterOperation, number> = {
  authorizations: 1,
  'claim-signatures': 2,
  'relay-broadcasts': 3,
};
const LOCK_NAMESPACE = 1_346_989_639;

export async function readRouterStopState(tx: DbOrTx = db): Promise<RouterStopState> {
  const rows = await tx.select({ key: kv.key, value: kv.value }).from(kv)
    .where(sql`${kv.key} in (${stopKeys.authorizations}, ${stopKeys['claim-signatures']}, ${stopKeys['relay-broadcasts']})`);
  const values = new Map(rows.map((row) => [row.key, row.value]));
  for (const [key, value] of values) {
    if (typeof value !== 'boolean') throw new Error(`Router incident stop state is malformed for ${key}; refusing writes.`);
  }
  return {
    authorizations: values.get(stopKeys.authorizations) === true,
    'claim-signatures': values.get(stopKeys['claim-signatures']) === true,
    'relay-broadcasts': values.get(stopKeys['relay-broadcasts']) === true,
  };
}

function environmentAllows(operation: RouterOperation): boolean {
  if (!config.ROUTER_ENABLED) return false;
  if (operation === 'authorizations') return config.ROUTER_NEW_AUTHORIZATIONS_ENABLED;
  if (operation === 'claim-signatures') return config.ROUTER_NEW_CLAIM_SIGNATURES_ENABLED;
  return config.ROUTER_RELAY_BROADCASTS_ENABLED;
}

/**
 * The environment is a hard upper bound. Inside a write transaction, the
 * shared advisory lock makes the check atomic with respect to the operator CLI:
 * a completed stop waits for in-flight signatures/broadcasts to commit.
 * Read failures propagate and therefore fail closed.
 */
export async function assertRouterOperationEnabled(operation: RouterOperation, tx?: DbOrTx): Promise<void> {
  const messages: Record<RouterOperation, string> = {
    authorizations: 'New send authorizations are paused.',
    'claim-signatures': 'New claim signatures are paused.',
    'relay-broadcasts': 'Claim relay broadcasts are paused.',
  };
  if (!environmentAllows(operation)) throw errors.conflict(messages[operation]);
  const target = tx ?? db;
  if (tx) await target.execute(sql`select pg_advisory_xact_lock_shared(${LOCK_NAMESPACE}, ${lockIds[operation]})`);
  const [row] = await target.select({ value: kv.value }).from(kv).where(eq(kv.key, stopKeys[operation])).limit(1);
  if (row && typeof row.value !== 'boolean') {
    throw new Error(`Router incident stop state is malformed for ${stopKeys[operation]}; refusing writes.`);
  }
  if (row?.value === true) throw errors.conflict(messages[operation]);
}

export function isRouterIncidentStop(error: unknown): boolean {
  return error instanceof AppError && error.code === 'CONFLICT';
}

export async function withRouterStopWriteLock<T>(
  operation: RouterOperation,
  fn: (tx: DbOrTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '30s'`);
    await tx.execute(sql`set local statement_timeout = '35s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${lockIds[operation]})`);
    return fn(tx);
  });
}

export const routerStopKvKey = (operation: RouterOperation): string => stopKeys[operation];
