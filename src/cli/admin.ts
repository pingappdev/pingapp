import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { and, count, desc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { config } from '../config.js';
import { audit } from '../db/audit.js';
import { db, sql as postgres } from '../db/client.js';
import { kvGet } from '../db/kv.js';
import { notify } from '../db/notify.js';
import {
  contacts,
  intents,
  phoneClaims,
  sessions,
  smsLog,
  tokens,
  transfers,
  users,
} from '../db/schema.js';
import { chain, isAddress, normAddress } from '../lib/chain.js';
import { decrypt, phoneHmac } from '../lib/crypto.js';
import { normalizePhone } from '../lib/phone.js';
import { redis } from '../lib/redis.js';
import { diagnoseRpcEndpoints } from '../lib/rpcPool.js';
import { sendSms, setSmsKillSwitch, sevenBalance, smsSentToday } from '../lib/sms.js';
import { clearPhoneIfOwned, lockPhoneMutation, linkPhoneToUser } from '../modules/phone/service.js';
import { syncStockTokens, syncWellKnown } from '../modules/tokens/registry.js';

const SMS_KILL_SWITCH_KEY = 'sms:disabled';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const TRANSFER_STATUSES = ['submitted', 'confirmed', 'failed', 'unverified', 'not_found'] as const;
const INTENT_STATUSES = ['pending', 'ready', 'completed', 'cancelled', 'expired'] as const;
const TOKEN_KINDS = ['native', 'stable', 'wrapped', 'stock'] as const;
const SMS_PURPOSES = ['otp', 'intent', 'admin_test'] as const;

class AdminCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminCliError';
  }
}

type CommonArgs = {
  positional: string[];
  yes: boolean;
  all: boolean;
  note: string | undefined;
};

type AwaitedTuple<T extends readonly unknown[]> = { -readonly [K in keyof T]: Awaited<T[K]> };

function validateNote(note: string | undefined): void {
  if (note && /(?:\+?\d[ \t().-]*){7,}/.test(note)) {
    cliError('Notes must not contain phone numbers or long digit sequences.');
  }
}

function cliError(message: string): never {
  throw new AdminCliError(message);
}

async function settleAll<T extends readonly unknown[]>(tasks: T): Promise<AwaitedTuple<T>> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as AwaitedTuple<T>;
}

function parseOptions(args: string[], allowed: Array<'--yes' | '--all' | '--note'> = []): CommonArgs {
  const positional: string[] = [];
  let yes = false;
  let all = false;
  let note: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--yes' && allowed.includes('--yes')) {
      if (yes) cliError('Use --yes only once.');
      yes = true;
    } else if (arg === '--all' && allowed.includes('--all')) {
      if (all) cliError('Use --all only once.');
      all = true;
    } else if (arg === '--note' && allowed.includes('--note')) {
      if (note !== undefined) cliError('Use --note only once.');
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) cliError('Provide a value after --note.');
      note = value.trim();
      if (note.length > 500) cliError('The note must be 500 characters or fewer.');
      validateNote(note);
      index += 1;
    } else if (arg.startsWith('--')) {
      cliError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { positional, yes, all, note };
}

function requirePositionals(args: CommonArgs, expected: number, usage: string): string[] {
  if (args.positional.length !== expected) cliError(`Usage: ${usage}`);
  return args.positional;
}

function printHelp(): void {
  console.log(`PingApp admin CLI

Commands:
  help
  stats
  claims:list [--all]
  claims:show <claim-id>
  claims:approve <claim-id> [--note "…"] [--yes]
  claims:reject <claim-id> [--note "…"] [--yes]
  user:show <address>
  user:unlink-phone <address> [--note "…"] [--yes]
  sms:disable
  sms:enable
  sms:status
  sms:test <+phone> [--yes]
  rpc:status
  tokens:sync

Destructive claim and phone changes show a summary and require typing "yes".
Pass --yes to skip the prompt for scripted operation. SMS tests also require
confirmation unless --yes is passed.`);
}

async function confirm(prompt: string, skip: boolean): Promise<boolean> {
  if (skip) {
    console.log('Confirmation skipped (--yes).');
    return true;
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`${prompt}\nType yes to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    readline.close();
  }
}

function requireUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    cliError(`${label} must be a UUID.`);
  }
  return value;
}

function requireAddress(value: string): string {
  if (!isAddress(value)) cliError('Provide a valid non-zero wallet address.');
  return normAddress(value);
}

async function readClaimRows(id?: string, all = false) {
  const claimOwner = alias(users, 'claim_owner');
  const claimants = alias(users, 'claimant');
  const filters = [];
  if (id) filters.push(eq(phoneClaims.id, id));
  if (!all) filters.push(eq(phoneClaims.status, 'pending_review'));

  return db.select({
    id: phoneClaims.id,
    status: phoneClaims.status,
    createdAt: phoneClaims.createdAt,
    resolvedAt: phoneClaims.resolvedAt,
    phoneMasked: phoneClaims.phoneMasked,
    phoneHmac: phoneClaims.phoneHmac,
    claimantAddress: claimants.address,
    claimantCreatedAt: claimants.createdAt,
    ownerAddress: claimOwner.address,
    ownerLastLoginAt: claimOwner.lastLoginAt,
    ownerPhoneLinkedAt: claimOwner.phoneLinkedAt,
  }).from(phoneClaims)
    .innerJoin(claimants, eq(claimants.id, phoneClaims.claimantUserId))
    .leftJoin(claimOwner, eq(claimOwner.id, phoneClaims.ownerUserId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(phoneClaims.createdAt));
}

async function listClaims(all: boolean): Promise<void> {
  const rows = await readClaimRows(undefined, all);
  console.table(rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    phoneMasked: row.phoneMasked,
    claimantAddress: row.claimantAddress,
    ownerAddress: row.ownerAddress ?? '—',
    ownerLastLoginAt: row.ownerLastLoginAt,
    ownerPhoneLinkedAt: row.ownerPhoneLinkedAt,
  })));
  console.log(`${rows.length} claim${rows.length === 1 ? '' : 's'}${all ? '' : ' pending review'}.`);
}

async function showClaim(id: string): Promise<void> {
  const [claim] = await readClaimRows(id, true);
  if (!claim) cliError('Claim not found.');
  console.table([{
    id: claim.id,
    status: claim.status,
    createdAt: claim.createdAt,
    resolvedAt: claim.resolvedAt,
    phoneMasked: claim.phoneMasked,
    claimantAddress: claim.claimantAddress,
    ownerAddress: claim.ownerAddress ?? '—',
    ownerLastLoginAt: claim.ownerLastLoginAt,
    ownerPhoneLinkedAt: claim.ownerPhoneLinkedAt,
    claimantCreatedAt: claim.claimantCreatedAt,
  }]);

  const [transferResult, intentResult] = await settleAll([
    claim.ownerAddress
      ? db.select({ total: count() }).from(transfers).where(and(
        eq(transfers.recipientAddress, claim.ownerAddress),
        eq(transfers.status, 'confirmed'),
      ))
      : Promise.resolve([{ total: 0 }]),
    db.select({ total: count() }).from(intents)
      .where(eq(intents.recipientPhoneHmac, claim.phoneHmac)),
  ] as const);
  console.table([{
    confirmedTransfersToOwner: transferResult[0]?.total ?? 0,
    intentsToClaimedPhone: intentResult[0]?.total ?? 0,
  }]);
}

async function previewClaim(id: string) {
  const [claim] = await readClaimRows(id, true);
  if (!claim) cliError('Claim not found.');
  if (claim.status !== 'pending_review') cliError('Claim is no longer pending review.');
  return claim;
}

async function approveClaim(id: string, note: string | undefined, yes: boolean): Promise<void> {
  const preview = await previewClaim(id);
  console.table([{
    action: 'approve claim',
    id: preview.id,
    phoneMasked: preview.phoneMasked,
    claimantAddress: preview.claimantAddress,
    claimOwnerAddress: preview.ownerAddress ?? 'none',
  }]);
  if (!await confirm('This moves the reviewed phone number to the claimant.', yes)) {
    console.log('Cancelled; no changes were made.');
    return;
  }

  const result = await db.transaction(async (tx) => {
    // This advisory transaction lock must precede every user, claim or intent row lock.
    await lockPhoneMutation(tx);
    const [claim] = await tx.select().from(phoneClaims)
      .where(eq(phoneClaims.id, id)).for('update').limit(1);
    if (!claim || claim.status !== 'pending_review') {
      cliError('Claim is no longer pending review; no changes were made.');
    }

    const phone = normalizePhone(decrypt(claim.phoneEnc));
    if (phoneHmac(phone.e164) !== claim.phoneHmac) {
      cliError('Stored claim details did not validate; no changes were made.');
    }

    const ownerCleared = claim.ownerUserId
      ? await clearPhoneIfOwned(tx, claim.ownerUserId, claim.phoneHmac)
      : false;
    const linked = await linkPhoneToUser(tx, claim.claimantUserId, phone);
    if (linked.kind !== 'linked') {
      // Roll back the old-owner clear and every claim/notification change if a different wallet now owns it.
      cliError('The phone owner changed while the claim was reviewed; no changes were made.');
    }

    const resolvedAt = new Date();
    await tx.update(phoneClaims).set({
      status: 'approved', resolvedAt, note: note ?? claim.note,
    }).where(and(eq(phoneClaims.id, claim.id), eq(phoneClaims.status, 'pending_review')));

    const competing = await tx.select().from(phoneClaims).where(and(
      eq(phoneClaims.phoneHmac, claim.phoneHmac),
      eq(phoneClaims.status, 'pending_review'),
      ne(phoneClaims.id, claim.id),
    )).for('update');
    if (competing.length) {
      const competingIds = competing.map((other) => other.id);
      await tx.update(phoneClaims).set({
        status: 'rejected',
        resolvedAt,
        note: `Superseded by approval of claim ${claim.id}`,
      }).where(and(inArray(phoneClaims.id, competingIds), eq(phoneClaims.status, 'pending_review')));
      for (const other of competing) {
        await notify(other.claimantUserId, 'phone_claim_resolved', {
          phoneMasked: other.phoneMasked, outcome: 'rejected',
        }, tx);
        await audit('claim_rejected', {
          userId: other.claimantUserId,
          data: { claimId: other.id, phoneMasked: other.phoneMasked, reason: 'superseded' },
        }, tx);
      }
    }

    if (ownerCleared && claim.ownerUserId && claim.ownerUserId !== claim.claimantUserId) {
      await notify(claim.ownerUserId, 'phone_removed_by_review', { phoneMasked: claim.phoneMasked }, tx);
    }
    await notify(claim.claimantUserId, 'phone_claim_resolved', {
      phoneMasked: claim.phoneMasked, outcome: 'approved',
    }, tx);
    await audit('claim_approved', {
      userId: claim.claimantUserId,
      data: { claimId: claim.id, phoneMasked: claim.phoneMasked, ownerCleared },
    }, tx);
    return { claimId: claim.id, ownerCleared, readyIntents: linked.readyIntents };
  });

  console.log(`Approved claim ${result.claimId}; owner phone cleared: ${result.ownerCleared ? 'yes' : 'no'}; ready intents: ${result.readyIntents}.`);
}

async function rejectClaim(id: string, note: string | undefined, yes: boolean): Promise<void> {
  const preview = await previewClaim(id);
  console.table([{
    action: 'reject claim',
    id: preview.id,
    phoneMasked: preview.phoneMasked,
    claimantAddress: preview.claimantAddress,
    claimOwnerAddress: preview.ownerAddress ?? 'none',
  }]);
  if (!await confirm('This closes the claim without changing phone ownership.', yes)) {
    console.log('Cancelled; no changes were made.');
    return;
  }

  const result = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const [claim] = await tx.select().from(phoneClaims)
      .where(eq(phoneClaims.id, id)).for('update').limit(1);
    if (!claim || claim.status !== 'pending_review') {
      cliError('Claim is no longer pending review; no changes were made.');
    }

    const resolvedAt = new Date();
    await tx.update(phoneClaims).set({
      status: 'rejected', resolvedAt, note: note ?? claim.note,
    }).where(and(eq(phoneClaims.id, claim.id), eq(phoneClaims.status, 'pending_review')));
    await notify(claim.claimantUserId, 'phone_claim_resolved', {
      phoneMasked: claim.phoneMasked, outcome: 'rejected',
    }, tx);
    await audit('claim_rejected', {
      userId: claim.claimantUserId,
      data: { claimId: claim.id, phoneMasked: claim.phoneMasked },
    }, tx);
    return claim.id;
  });

  console.log(`Rejected claim ${result}.`);
}

async function showUser(address: string): Promise<void> {
  const normalized = requireAddress(address);
  const [user] = await db.select({
    id: users.id,
    address: users.address,
    displayName: users.displayName,
    createdAt: users.createdAt,
    lastLoginAt: users.lastLoginAt,
    phoneMasked: users.phoneMasked,
    phoneLinkedAt: users.phoneLinkedAt,
  }).from(users).where(eq(users.address, normalized)).limit(1);
  if (!user) cliError('User not found.');

  const [sessionCounts, contactCount, transferCount, intentCount, pendingClaimCount] = await settleAll([
    db.select({
      total: count(),
      active: sql<number>`count(*) filter (where ${sessions.expiresAt} > now())::int`,
    }).from(sessions).where(eq(sessions.userId, user.id)),
    db.select({ total: count() }).from(contacts).where(eq(contacts.userId, user.id)),
    db.select({ total: count() }).from(transfers).where(or(
      eq(transfers.senderAddress, user.address), eq(transfers.recipientAddress, user.address),
    )),
    db.select({ total: count() }).from(intents).where(or(
      eq(intents.senderUserId, user.id), eq(intents.recipientUserId, user.id),
    )),
    db.select({ total: count() }).from(phoneClaims).where(and(
      eq(phoneClaims.status, 'pending_review'),
      or(eq(phoneClaims.claimantUserId, user.id), eq(phoneClaims.ownerUserId, user.id)),
    )),
  ] as const);

  console.table([{
    address: user.address,
    displayName: user.displayName || '—',
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    phoneMasked: user.phoneMasked ?? '—',
    phoneLinkedAt: user.phoneLinkedAt,
  }]);
  console.table([{
    sessions: sessionCounts[0]?.total ?? 0,
    activeSessions: sessionCounts[0]?.active ?? 0,
    contacts: contactCount[0]?.total ?? 0,
    transfers: transferCount[0]?.total ?? 0,
    intents: intentCount[0]?.total ?? 0,
    pendingClaims: pendingClaimCount[0]?.total ?? 0,
  }]);
}

async function previewUser(address: string) {
  const normalized = requireAddress(address);
  const [user] = await db.select({
    id: users.id,
    address: users.address,
    displayName: users.displayName,
    phoneMasked: users.phoneMasked,
    phoneHmac: users.phoneHmac,
  }).from(users).where(eq(users.address, normalized)).limit(1);
  if (!user) cliError('User not found.');
  if (!user.phoneMasked) cliError('This user has no linked phone number.');
  return user;
}

async function unlinkUserPhone(address: string, note: string | undefined, yes: boolean): Promise<void> {
  const preview = await previewUser(address);
  console.table([{
    action: 'unlink phone',
    address: preview.address,
    displayName: preview.displayName || '—',
    phoneMasked: preview.phoneMasked,
  }]);
  if (!await confirm('This removes the linked phone and returns matching ready intents to pending.', yes)) {
    console.log('Cancelled; no changes were made.');
    return;
  }

  const result = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const [user] = await tx.select().from(users).where(eq(users.id, preview.id)).for('update').limit(1);
    if (!user) cliError('User no longer exists; no changes were made.');
    if (!preview.phoneHmac || user.phoneHmac !== preview.phoneHmac || !user.phoneMasked) {
      return { cleared: false, phoneMasked: null };
    }

    const cleared = await clearPhoneIfOwned(tx, user.id, preview.phoneHmac);
    if (!cleared) return { cleared: false, phoneMasked: null };
    await audit('phone_unlinked_by_admin', {
      userId: user.id,
      data: { phoneMasked: user.phoneMasked, note: note ?? null },
    }, tx);
    return { cleared: true, phoneMasked: user.phoneMasked };
  });

  console.log(result.cleared
    ? `Unlinked phone ${result.phoneMasked} from ${preview.address}.`
    : `No phone was unlinked from ${preview.address}; the owner had changed.`);
}

async function smsState() {
  const [countToday, switchValue] = await settleAll([
    smsSentToday(),
    redis.get(SMS_KILL_SWITCH_KEY),
  ] as const);
  const killSwitch = switchValue === '1';
  return {
    configuredEnabled: config.SMS_ENABLED,
    killSwitch,
    available: config.SMS_ENABLED && !killSwitch && countToday < config.SMS_DAILY_CAP,
    countToday,
    dailyCap: config.SMS_DAILY_CAP,
    driver: config.SMS_DRIVER,
  };
}

async function showSmsStatus(): Promise<void> {
  const status = await smsState();
  console.table([{
    enabled: status.configuredEnabled,
    killSwitch: status.killSwitch,
    available: status.available,
    today: status.countToday,
    cap: status.dailyCap,
    driver: status.driver,
  }]);
}

async function stats(): Promise<void> {
  const since24h = new Date(Date.now() - DAY_MS);
  const since7d = new Date(Date.now() - WEEK_MS);
  const labels = [
    'user totals', 'active sessions', 'transfer totals', 'recent transfer totals', 'intent totals',
    'SMS results', 'token totals', 'SMS status', 'seven.io balance', 'token sync time',
  ];
  const tasks = [
    Promise.resolve().then(() => db.select({
      total: count(),
      withPhone: sql<number>`count(*) filter (where ${users.phoneHmac} is not null)::int`,
    }).from(users)),
    Promise.resolve().then(() => db.select({ total: count() }).from(sessions).where(gt(sessions.expiresAt, new Date()))),
    Promise.resolve().then(() => db.select({ status: transfers.status, total: count() }).from(transfers).groupBy(transfers.status)),
    Promise.resolve().then(() => db.select({ status: transfers.status, total: count() }).from(transfers)
      .where(gt(transfers.createdAt, since24h)).groupBy(transfers.status)),
    Promise.resolve().then(() => db.select({ status: intents.status, total: count() }).from(intents).groupBy(intents.status)),
    Promise.resolve().then(() => db.select({
      purpose: smsLog.purpose,
      success: sql<number>`count(*) filter (where ${smsLog.success} = true)::int`,
      fail: sql<number>`count(*) filter (where ${smsLog.success} = false)::int`,
    }).from(smsLog).where(gt(smsLog.createdAt, since7d)).groupBy(smsLog.purpose)),
    Promise.resolve().then(() => db.select({ kind: tokens.kind, total: count() }).from(tokens)
      .where(eq(tokens.chainId, chain.id)).groupBy(tokens.kind)),
    smsState(),
    sevenBalance(),
    kvGet<{ at?: unknown }>('tokens:lastSync'),
  ] as const;
  const results = await Promise.allSettled(tasks);
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [labels[index]] : []);
  if (failures.length) {
    for (const label of failures) console.error(`Stats could not retrieve ${label}.`);
    cliError('Stats could not be completed.');
  }
  const [userCounts, activeSessions, transferRows, recentTransferRows, intentRows, smsRows, tokenRows,
    sms, balance, lastSync] = await Promise.all(tasks);

  const transfersByStatus = new Map(transferRows.map((row) => [row.status, row.total]));
  const recentTransfersByStatus = new Map(recentTransferRows.map((row) => [row.status, row.total]));
  const intentsByStatus = new Map(intentRows.map((row) => [row.status, row.total]));
  const smsByPurpose = new Map(smsRows.map((row) => [row.purpose, row]));
  const tokensByKind = new Map(tokenRows.map((row) => [row.kind, row.total]));
  const tokenSyncTime = typeof lastSync?.at === 'string' ? lastSync.at : 'never';

  console.log(`Chain: ${chain.name} (${chain.id})`);
  console.table([{
    users: userCounts[0]?.total ?? 0,
    usersWithPhone: userCounts[0]?.withPhone ?? 0,
    activeSessions: activeSessions[0]?.total ?? 0,
    smsToday: `${sms.countToday}/${sms.dailyCap}`,
    smsConfiguredEnabled: sms.configuredEnabled,
    smsKillSwitch: sms.killSwitch,
    smsDriver: sms.driver,
    sevenBalance: balance === null ? (config.SEVEN_API_KEY ? 'unavailable' : 'not configured') : balance,
    lastTokenSync: tokenSyncTime,
  }]);

  console.log('Transfers by status');
  console.table(TRANSFER_STATUSES.map((status) => ({
    status,
    allTime: transfersByStatus.get(status) ?? 0,
    last24h: recentTransfersByStatus.get(status) ?? 0,
  })));

  console.log('Intents by status');
  console.table(INTENT_STATUSES.map((status) => ({ status, total: intentsByStatus.get(status) ?? 0 })));

  console.log('SMS in the last 7 days by purpose');
  console.table(SMS_PURPOSES.map((purpose) => ({
    purpose,
    success: smsByPurpose.get(purpose)?.success ?? 0,
    fail: smsByPurpose.get(purpose)?.fail ?? 0,
  })));

  console.log('Tokens by kind');
  console.table(TOKEN_KINDS.map((kind) => ({ kind, total: tokensByKind.get(kind) ?? 0 })));
}

async function testSms(phoneInput: string, yes: boolean): Promise<void> {
  let phone;
  try {
    phone = normalizePhone(phoneInput);
  } catch {
    cliError('Provide a valid international mobile phone number.');
  }
  console.log(`SMS test target: ${phone.masked}; message: "PingApp test message."; driver: ${config.SMS_DRIVER}.`);
  if (!await confirm('The test uses the current SMS driver and consumes one daily-cap slot.', yes)) {
    console.log('Cancelled; no message was sent.');
    return;
  }

  try {
    await sendSms({
      purpose: 'admin_test',
      toE164: phone.e164,
      text: 'PingApp test message.',
      phoneHmac: phoneHmac(phone.e164),
      country: phone.country,
    });
    console.log('SMS test accepted by the configured driver.');
  } catch {
    cliError('SMS test was not sent because SMS is disabled or unavailable.');
  }
}

async function rpcStatus(): Promise<void> {
  const rows = await diagnoseRpcEndpoints();
  console.table(rows.map((row) => ({
    endpoint: row.id,
    ok: row.ok,
    latencyMs: row.latencyMs ?? '—',
  })));
  if (!rows.length) cliError('No RPC endpoints are configured.');
  if (!rows.some((row) => row.ok)) cliError('Every configured RPC endpoint failed.');
}

async function syncTokens(): Promise<void> {
  await syncWellKnown();
  await syncStockTokens();
  const rows = await db.select({ kind: tokens.kind, total: count() }).from(tokens)
    .where(eq(tokens.chainId, chain.id)).groupBy(tokens.kind);
  const byKind = new Map(rows.map((row) => [row.kind, row.total]));
  console.log(`Token registry synced for ${chain.name} (${chain.id}).`);
  console.table(TOKEN_KINDS.map((kind) => ({ kind, total: byKind.get(kind) ?? 0 })));
}

async function dispatch(command: string, rawArgs: string[]): Promise<void> {
  if (command === 'help') {
    if (rawArgs.length) cliError('Usage: help');
    printHelp();
    return;
  }
  if (command === 'stats') {
    if (rawArgs.length) cliError('Usage: stats');
    await stats();
    return;
  }
  if (command === 'claims:list') {
    const args = parseOptions(rawArgs, ['--all']);
    requirePositionals(args, 0, 'claims:list [--all]');
    await listClaims(args.all);
    return;
  }
  if (command === 'claims:show') {
    const args = parseOptions(rawArgs);
    const [id] = requirePositionals(args, 1, 'claims:show <claim-id>');
    await showClaim(requireUuid(id, 'Claim ID'));
    return;
  }
  if (command === 'claims:approve' || command === 'claims:reject') {
    const args = parseOptions(rawArgs, ['--yes', '--note']);
    const [id] = requirePositionals(args, 1, `${command} <claim-id> [--note "…"] [--yes]`);
    const claimId = requireUuid(id, 'Claim ID');
    if (command === 'claims:approve') await approveClaim(claimId, args.note, args.yes);
    else await rejectClaim(claimId, args.note, args.yes);
    return;
  }
  if (command === 'user:show') {
    const args = parseOptions(rawArgs);
    const [address] = requirePositionals(args, 1, 'user:show <address>');
    await showUser(address);
    return;
  }
  if (command === 'user:unlink-phone') {
    const args = parseOptions(rawArgs, ['--yes', '--note']);
    const [address] = requirePositionals(args, 1, 'user:unlink-phone <address> [--note "…"] [--yes]');
    await unlinkUserPhone(address, args.note, args.yes);
    return;
  }
  if (command === 'sms:disable' || command === 'sms:enable') {
    const args = parseOptions(rawArgs);
    requirePositionals(args, 0, `${command}`);
    const disabled = command === 'sms:disable';
    await setSmsKillSwitch(disabled);
    console.log(`SMS kill switch ${disabled ? 'enabled' : 'cleared'}.`);
    if (!disabled && !config.SMS_ENABLED) console.log('SMS_ENABLED=false still disables delivery.');
    return;
  }
  if (command === 'sms:status') {
    const args = parseOptions(rawArgs);
    requirePositionals(args, 0, 'sms:status');
    await showSmsStatus();
    return;
  }
  if (command === 'sms:test') {
    const args = parseOptions(rawArgs, ['--yes']);
    const [phone] = requirePositionals(args, 1, 'sms:test <+phone> [--yes]');
    await testSms(phone, args.yes);
    return;
  }
  if (command === 'rpc:status') {
    const args = parseOptions(rawArgs);
    requirePositionals(args, 0, 'rpc:status');
    await rpcStatus();
    return;
  }
  if (command === 'tokens:sync') {
    const args = parseOptions(rawArgs);
    requirePositionals(args, 0, 'tokens:sync');
    await syncTokens();
    return;
  }

  cliError(`Unknown command: ${command}\nRun "make admin ARGS=help" for usage.`);
}

async function closeResources(): Promise<void> {
  const results = await Promise.allSettled([postgres.end(), redis.quit()]);
  if (results.some((result) => result.status === 'rejected')) {
    console.error('Could not close all database and Redis connections cleanly.');
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  await dispatch(command, args);
}

try {
  await main();
} catch (error) {
  if (error instanceof AdminCliError) {
    console.error(error.message);
  } else {
    // Database, provider and decryption exceptions can contain private values. Keep CLI errors generic.
    console.error('Command failed. Check database, Redis and provider availability, then retry.');
  }
  process.exitCode = 1;
} finally {
  await closeResources();
}
