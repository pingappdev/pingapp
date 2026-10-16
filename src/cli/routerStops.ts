import { config } from '../config.js';
import { sql } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { kvSet } from '../db/kv.js';
import { readRouterStopState, routerStopKvKey, withRouterStopWriteLock, type RouterOperation } from '../modules/escrows/incident.js';

const operations: RouterOperation[] = ['authorizations', 'claim-signatures', 'relay-broadcasts'];

function printHelp(): void {
  console.log(`Router incident stops (uses the app database; requires operator write access)

Usage:
  node dist/cli/routerStops.js status
  node dist/cli/routerStops.js stop <authorizations|claim-signatures|relay-broadcasts>
  node dist/cli/routerStops.js resume <authorizations|claim-signatures|relay-broadcasts>

Each stop is durable and live. A stop waits for any in-flight signature or
broadcast transaction of that class to finish (up to 30 seconds). If an
in-flight action does not finish, the command fails and the stop is not changed.
Environment flags remain hard stops and cannot be overridden by resume.`);
}

async function main(): Promise<void> {
  const [command, operationInput] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }
  if (command === 'status') {
    const stops = await readRouterStopState();
    console.log(JSON.stringify({
      databaseStops: stops,
      environmentAllows: {
        authorizations: config.ROUTER_ENABLED && config.ROUTER_NEW_AUTHORIZATIONS_ENABLED,
        'claim-signatures': config.ROUTER_ENABLED && config.ROUTER_NEW_CLAIM_SIGNATURES_ENABLED,
        'relay-broadcasts': config.ROUTER_ENABLED && config.ROUTER_RELAY_BROADCASTS_ENABLED,
      },
    }, null, 2));
    return;
  }
  if (command !== 'stop' && command !== 'resume') throw new Error('Expected status, stop, or resume.');
  if (!operationInput || !operations.includes(operationInput as RouterOperation)) {
    throw new Error('Choose one operation: authorizations, claim-signatures, or relay-broadcasts.');
  }
  const operation = operationInput as RouterOperation;
  const stopped = command === 'stop';
  await withRouterStopWriteLock(operation, async (tx) => {
    await kvSet(routerStopKvKey(operation), stopped, tx);
    await tx.insert(auditEvents).values({
      type: 'router_incident_stop_changed',
      data: { operation, stopped, changedAt: new Date().toISOString() },
    });
  });
  console.log(`${operation}: ${stopped ? 'stopped' : 'resumed'} (environment hard limits still apply).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Router stop command failed.');
  process.exitCode = 1;
}).finally(async () => { await sql.end(); });
