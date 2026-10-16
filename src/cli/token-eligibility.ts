import { and, eq } from 'drizzle-orm';
import { db, sql as postgres } from '../db/client.js';
import { tokenEligibilityBlocks, tokens } from '../db/schema.js';
import { chain, isAddress, normAddress } from '../lib/chain.js';
import { normalizeMultiplier, blockTokenForNewAuthorizations, unblockTokenForNewAuthorizations } from '../modules/tokens/eligibility.js';

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function parseArgs(args: string[]) {
  const positional: string[] = [];
  let reason: string | undefined;
  let reviewedMultiplier: string | undefined;
  let reviewRevision: string | undefined;
  let yes = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--reason' || arg === '--review-multiplier' || arg === '--review-revision') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`Provide a value after ${arg}.`);
      if (arg === '--reason') {
        if (reason !== undefined) fail('Use --reason only once.');
        reason = value.trim();
      } else {
        if (arg === '--review-multiplier') {
          if (reviewedMultiplier !== undefined) fail('Use --review-multiplier only once.');
          reviewedMultiplier = value;
        } else {
          if (reviewRevision !== undefined) fail('Use --review-revision only once.');
          reviewRevision = value;
        }
      }
      index += 1;
    } else if (arg === '--yes') {
      if (yes) fail('Use --yes only once.');
      yes = true;
    } else if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, reason, reviewedMultiplier, reviewRevision, yes };
}

function requireAddress(value: string): string {
  if (!isAddress(value)) fail('Provide a valid token address.');
  return normAddress(value);
}

async function list(): Promise<void> {
  const rows = await db.select({ token: tokens, block: tokenEligibilityBlocks })
    .from(tokens).leftJoin(tokenEligibilityBlocks, eq(tokenEligibilityBlocks.tokenAddress, tokens.address))
    .where(eq(tokens.chainId, chain.id)).orderBy(tokens.sort, tokens.symbol);
  console.table(rows.map(({ token, block }) => ({
    address: token.address,
    symbol: token.symbol,
    issuerActive: token.active,
    multiplier: token.kind === 'stock' ? token.multiplier : '—',
    multiplierKnown: token.kind === 'stock' ? token.multiplierKnown : '—',
    reviewRevision: block?.reviewRevision ?? '—',
    newAuthorization: !token.active ? 'issuer_inactive' : block?.source === 'issuer_multiplier_change'
      ? 'review_required' : block ? 'operator_blocked' : 'not_operator_reviewed',
    reason: block?.reason ?? '—',
  })));
}

async function main(): Promise<void> {
  const [command = 'help', ...rawArgs] = process.argv.slice(2);
  if (command === 'help') {
    console.log(`Token authorization eligibility

Commands:
  list
  block <token-address> --reason "review note" --yes
  unblock <token-address> --review-revision <listed-id> [--review-multiplier <current-value>] --yes

For stock tokens with known issuer unit-conversion metadata, unblock requires
--review-multiplier to match both the current registry value and the value
recorded on the block. Every substantive block or metadata change receives a new
review revision; --review-revision must match the latest value from list.`);
    return;
  }
  const args = parseArgs(rawArgs);
  if (command === 'list') {
    if (args.positional.length || args.reason !== undefined || args.reviewedMultiplier !== undefined || args.reviewRevision !== undefined || args.yes) fail('Usage: list');
    await list();
    return;
  }
  if (command === 'block') {
    if (args.positional.length !== 1 || args.reviewedMultiplier !== undefined || args.reviewRevision !== undefined || !args.reason || !args.yes) {
      fail('Usage: block <token-address> --reason "review note" --yes');
    }
    if (args.reason.length > 500) fail('Reason must be 500 characters or fewer.');
    await blockTokenForNewAuthorizations(requireAddress(args.positional[0]), args.reason);
    console.log('New escrow authorizations are blocked for this token. Existing obligations remain unchanged.');
    return;
  }
  if (command === 'unblock') {
    if (args.positional.length !== 1 || args.reason !== undefined || !args.reviewRevision || !args.yes ||
      args.reviewedMultiplier !== undefined && normalizeMultiplier(args.reviewedMultiplier) === null) {
      fail('Usage: unblock <token-address> --review-revision <listed-id> [--review-multiplier <current-value>] --yes');
    }
    await unblockTokenForNewAuthorizations(requireAddress(args.positional[0]), args.reviewRevision, args.reviewedMultiplier);
    console.log('The operator authorization block was cleared. Existing obligations remain unchanged.');
    return;
  }
  fail('Unknown command. Run token-eligibility help.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof CliError ? error.message : 'Command failed. Check database availability and token state, then retry.');
  process.exitCode = 1;
} finally {
  await postgres.end();
}
