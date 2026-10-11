import { Readable } from 'node:stream';
import { and, eq, gt, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { decodeEventLog, erc20Abi, TransactionReceiptNotFoundError, type TransactionReceipt } from 'viem';
import { db } from '../../db/client.js';
import { audit } from '../../db/audit.js';
import { notify } from '../../db/notify.js';
import { contacts, intents, routerAuths, tokens, transfers, users, type Token, type Transfer } from '../../db/schema.js';
import { checksum, explorerTx, isAddress, NATIVE_TOKEN, normAddress } from '../../lib/chain.js';
import { invalidate } from '../../lib/cache.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatAmount } from '../../lib/money.js';
import { enqueue } from '../../lib/queue.js';
import { publicClient } from '../../lib/viem.js';
import { assertMinAmount, getMinAmountRaw } from '../tokens/minimum.js';
import { getPrices } from '../tokens/prices.js';
import { getToken } from '../tokens/registry.js';
import { toTokenDto, type TokenDto } from '../tokens/routes.js';
import { lockPhoneMutation } from '../phone/lock.js';
import { hasRouterSentLog } from './routerProof.js';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW_AMOUNT = /^[1-9]\d{0,77}$/;

export type TransferBody = {
  txHash: string;
  expectedSenderAddress: string;
  tokenAddress: string;
  amountRaw: string;
  toAddress: string;
  recipientPhone?: string;
  contactId?: string;
  intentId?: string;
  routerId?: string;
};

type Sender = { id: string; address: string };

async function byHash(hash: string): Promise<Transfer | null> {
  const [row] = await db.select().from(transfers).where(eq(transfers.txHash, hash)).limit(1);
  return row ?? null;
}

function sameSender(row: Transfer, userId: string): Transfer {
  if (row.senderUserId !== userId) throw errors.conflict('This transaction is already recorded.');
  return row;
}

/** The unique transaction hash is the idempotency key, including simultaneous POSTs. */
export async function recordTransfer(user: Sender, body: TransferBody): Promise<{ row: Transfer; created: boolean }> {
  if (!isAddress(body.expectedSenderAddress)) throw errors.invalidAddress('Enter the sending wallet address again.');
  if (normAddress(body.expectedSenderAddress) !== normAddress(user.address)) {
    throw errors.conflict('Your PingApp session changed. Reconnect the original sending wallet and sign in to save this transfer.');
  }
  if (!HASH.test(body.txHash)) throw errors.validation('Enter a valid transaction hash.');
  if (body.routerId && !HASH.test(body.routerId)) throw errors.validation('Invalid router authorization.');
  if (!RAW_AMOUNT.test(body.amountRaw)) throw errors.invalidAmount();
  if (!isAddress(body.toAddress)) throw errors.invalidAddress();
  const toAddress = normAddress(body.toAddress);
  if (toAddress === normAddress(user.address)) throw errors.selfSend();
  const hash = body.txHash.toLowerCase();

  const prior = await byHash(hash);
  if (prior) return { row: sameSender(prior, user.id), created: false };
  const token = await getToken(body.tokenAddress);
  if (!token) throw errors.unknownToken();

  // Enforce the API contract for every recovered payment.
  await assertMinAmount(token, BigInt(body.amountRaw), { tolerancePct: 10 });
  // Legacy hash recovery must not become a free phone/wallet matching oracle.
  // Verify payment before consulting any private recipient binding.
  const proof = { txHash: hash, senderAddress: normAddress(user.address), recipientAddress: toAddress,
    tokenAddress: token.address, amountRaw: body.amountRaw, routerId: body.routerId?.toLowerCase() ?? null };
  let receipt: TransactionReceipt;
  try { receipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` }); }
  catch { throw errors.conflict('The payment is not confirmed yet. Retry saving this transaction shortly.'); }
  const paid = receipt.status === 'success';
  let verified = receipt.transactionHash.toLowerCase() === hash && receipt.from.toLowerCase() === proof.senderAddress;
  if (verified && paid && proof.routerId) verified = hasRouterSentLog(receipt, proof);
  else if (verified && paid && token.address === NATIVE_TOKEN) {
    const transaction = await publicClient.getTransaction({ hash: hash as `0x${string}` });
    verified = transaction.from.toLowerCase() === proof.senderAddress &&
      transaction.to?.toLowerCase() === toAddress && transaction.value === BigInt(body.amountRaw);
  } else if (verified && paid) verified = hasExactTransferLog(receipt, proof);
  if (!verified) throw errors.validation('This transaction does not prove the specified payment.');

  const result = await db.transaction(async (tx) => {
    // Phone linking, intent readiness and account deletion use this global lock
    // first. Hold it through the binding checks and insert, without RPC calls.
    await lockPhoneMutation(tx);
    const [sender] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, user.id), eq(users.address, normAddress(user.address))))
      .limit(1).for('update');
    if (!sender) throw errors.unauthenticated();
    // A reverted legacy hash can still be saved as a failed attempt, but never
    // reads or attaches another user's private profile/phone metadata.
    const [recipient] = paid ? await tx.select().from(users)
      .where(eq(users.address, toAddress)).limit(1).for('update') : [];

    const [routerAuth] = body.routerId ? await tx.select().from(routerAuths)
      .where(eq(routerAuths.id, body.routerId.toLowerCase())).limit(1) : [];
    if (body.routerId && (!routerAuth || routerAuth.senderUserId !== user.id ||
        routerAuth.senderAddress !== normAddress(user.address) || routerAuth.tokenAddress !== token.address ||
        BigInt(routerAuth.amountRaw) !== BigInt(body.amountRaw) || routerAuth.recipientAddress !== toAddress)) {
      throw errors.validation('This transfer does not match your router authorization.');
    }

    let contactName: string | null = null;
    if (body.contactId) {
      const [contact] = await tx.select({ name: contacts.name }).from(contacts)
        .where(and(eq(contacts.id, body.contactId), eq(contacts.userId, user.id))).limit(1);
      if (!contact) throw errors.validation('This contact is unavailable.');
      contactName = contact.name;
    }

    // Legacy recovery proves a wallet payment, not a phone association. Never
    // compare a caller's guessed phone against a known wallet, even with a reused
    // valid receipt. Only an existing server authorization supplies phone metadata.
    const [inserted] = await tx.insert(transfers).values({
      senderUserId: user.id,
      senderAddress: normAddress(user.address),
      recipientAddress: toAddress,
      recipientUserId: recipient?.id ?? null,
      recipientPhoneHmac: paid ? routerAuth?.recipientPhoneHmac ?? null : null,
      recipientPhoneMasked: paid ? routerAuth?.recipientPhoneMasked ?? null : null,
      tokenAddress: token.address,
      amountRaw: body.amountRaw,
      txHash: hash,
      status: 'submitted',
      contactName,
      intentId: null,
      routerId: body.routerId?.toLowerCase() ?? null,
    }).onConflictDoNothing().returning();
    if (!inserted) {
      const [existing] = await tx.select().from(transfers).where(eq(transfers.txHash, hash)).limit(1);
      if (!existing) throw errors.conflict('This router authorization already has a recorded transaction.');
      return { row: sameSender(existing, user.id), created: false };
    }
    await audit('transfer_recorded', { userId: user.id, data: { transferId: inserted.id, token: token.symbol } }, tx);
    return { row: inserted, created: true };
  });

  if (result.created) {
    await enqueue('transfers', 'confirm', { transferId: result.row.id, attempt: 0 }, {
      delay: 4000, jobId: `confirm-${result.row.id}-0`,
    });
  }
  return result;
}

const NOT_FOUND_MS = 30 * 60 * 1000;
const SWEEP_CUTOFF_MS = 35 * 60 * 1000;

async function markNotFound(row: Transfer): Promise<void> {
  await db.update(transfers).set({ status: 'not_found' })
    .where(and(eq(transfers.id, row.id), eq(transfers.status, 'submitted')));
}

async function retryConfirmation(row: Transfer, attempt: number): Promise<void> {
  if (Date.now() - row.createdAt.getTime() >= SWEEP_CUTOFF_MS) {
    await markNotFound(row);
    return;
  }
  const nextAttempt = Math.max(0, Math.floor(attempt)) + 1;
  const delay = Math.min(60_000, Math.round(4000 * 1.6 ** Math.min(nextAttempt - 1, 20)));
  await enqueue('transfers', 'confirm', { transferId: row.id, attempt: nextAttempt }, {
    delay, jobId: `confirm-${row.id}-${nextAttempt}`,
  });
}

function hasExactTransferLog(receipt: TransactionReceipt, row: Pick<Transfer, 'tokenAddress' | 'senderAddress' | 'recipientAddress' | 'amountRaw'>): boolean {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== row.tokenAddress || log.topics.length !== 3 || log.data.length !== 66) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
      if (event.args.from.toLowerCase() === row.senderAddress &&
          event.args.to.toLowerCase() === row.recipientAddress &&
          event.args.value === BigInt(row.amountRaw)) return true;
    } catch {
      // A malformed or unrelated log cannot verify this transfer.
    }
  }
  return false;
}

function displayName(name: string | null | undefined, address: string): string {
  return name || `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function finalizeMined(row: Transfer, receipt: TransactionReceipt, verified: boolean): Promise<void> {
  const status = receipt.status === 'reverted' ? 'failed' : verified ? 'confirmed' : 'unverified';
  const token = await getToken(row.tokenAddress);
  // A token can become inactive after recording; its persisted metadata still exists.
  const [tokenRow] = token ? [token] : await db.query.tokens.findMany({
    where: (table, operators) => operators.eq(table.address, row.tokenAddress), limit: 1,
  });
  if (!tokenRow) throw new Error('Recorded transfer token is missing.');
  const amount = formatAmount(row.amountRaw, tokenRow.decimals);

  const changed = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const [updated] = await tx.update(transfers).set({
      status, blockNumber: receipt.blockNumber, confirmedAt: new Date(),
    }).where(and(eq(transfers.id, row.id), eq(transfers.status, 'submitted')))
      .returning({
        id: transfers.id,
        senderUserId: transfers.senderUserId,
        recipientUserId: transfers.recipientUserId,
      });
    if (!updated) return false;

    if (status === 'failed' && updated.senderUserId) {
      await notify(updated.senderUserId, 'transfer_failed', { transferId: row.id, amount, symbol: tokenRow.symbol }, tx);
    }
    if (status === 'confirmed') {
      if (updated.recipientUserId) {
        const [sender] = updated.senderUserId
          ? await tx.select({ name: users.displayName }).from(users)
            .where(eq(users.id, updated.senderUserId)).limit(1)
          : [];
        await notify(updated.recipientUserId, 'transfer_received', {
          transferId: row.id,
          senderDisplayName: displayName(sender?.name, row.senderAddress),
          amount, symbol: tokenRow.symbol,
        }, tx);
      }
      if (row.intentId && updated.recipientUserId) {
        // Phone changes reset ready intents. The extra current-binding and expiry
        // guards prevent a late receipt from completing a stale intent.
        const [recipient] = await tx.select({ phoneHmac: users.phoneHmac }).from(users)
          .where(eq(users.id, updated.recipientUserId)).limit(1);
        if (recipient?.phoneHmac) {
          await tx.update(intents).set({ status: 'completed', transferId: row.id, completedAt: new Date() })
            .where(and(eq(intents.id, row.intentId), eq(intents.status, 'ready'),
              eq(intents.recipientUserId, updated.recipientUserId),
              eq(intents.recipientPhoneHmac, recipient.phoneHmac),
              gt(intents.expiresAt, new Date())));
        }
      }
    }
    return true;
  });

  if (changed && status === 'confirmed') {
    const result = await Promise.allSettled([
      invalidate(`bal:${row.senderAddress}`), invalidate(`bal:${row.recipientAddress}`),
    ]);
    if (result.some((item) => item.status === 'rejected')) {
      logger.warn({ transferId: row.id }, 'balance cache invalidation failed after confirmation');
    }
  }
}

/** Mined status and all resulting notifications commit in the same DB transaction. */
export async function confirmTransfer(transferId: string, attempt: number): Promise<void> {
  const [row] = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1);
  if (!row || row.status !== 'submitted') return;

  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: row.txHash as `0x${string}` });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError &&
        Date.now() - row.createdAt.getTime() >= NOT_FOUND_MS) {
      await markNotFound(row);
      return;
    }
    // Missing receipts and transient RPC failures both need another bounded probe.
    await retryConfirmation(row, attempt);
    return;
  }

  if (receipt.transactionHash.toLowerCase() !== row.txHash) {
    await retryConfirmation(row, attempt);
    return;
  }
  if (receipt.status === 'reverted') {
    await finalizeMined(row, receipt, false);
    return;
  }

  let verified: boolean;
  if (row.routerId) {
    verified = hasRouterSentLog(receipt, row);
  } else if (row.tokenAddress === NATIVE_TOKEN) {
    try {
      const tx = await publicClient.getTransaction({ hash: row.txHash as `0x${string}` });
      verified = tx.from.toLowerCase() === row.senderAddress &&
        tx.to?.toLowerCase() === row.recipientAddress && tx.value === BigInt(row.amountRaw);
    } catch {
      await retryConfirmation(row, attempt);
      return;
    }
  } else {
    verified = hasExactTransferLog(receipt, row);
  }
  await finalizeMined(row, receipt, verified);
}

export type Direction = 'all' | 'sent' | 'received';
export type TransferDto = {
  id: string;
  direction: 'sent' | 'received';
  txHash: `0x${string}`;
  status: string;
  token: TokenDto;
  amountRaw: string;
  amount: string;
  from: { address: `0x${string}`; displayName: string | null; phoneMasked: null; isMe: boolean };
  to: { address: `0x${string}`; displayName: string | null; phoneMasked: string | null; isMe: boolean };
  contactName: string | null;
  intentId: string | null;
  explorerUrl: string;
  createdAt: string;
  confirmedAt: string | null;
};

const senderParty = alias(users, 'transfer_sender');
const recipientParty = alias(users, 'transfer_recipient');
const createdExact = sql<string>`to_char(${transfers.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const fields = {
  transfer: transfers,
  token: tokens,
  senderName: senderParty.displayName,
  recipientName: recipientParty.displayName,
  createdExact,
};

type JoinedRow = {
  transfer: Transfer;
  token: Token;
  senderName: string | null;
  recipientName: string | null;
  createdExact: string;
};

function joined() {
  return db.select(fields).from(transfers)
    .innerJoin(tokens, eq(tokens.address, transfers.tokenAddress))
    .leftJoin(senderParty, eq(senderParty.address, transfers.senderAddress))
    .leftJoin(recipientParty, eq(recipientParty.id, transfers.recipientUserId));
}

function visibleTo(userId: string, direction: Direction) {
  if (direction === 'sent') return eq(transfers.senderUserId, userId);
  if (direction === 'received') return eq(transfers.recipientUserId, userId);
  return or(eq(transfers.senderUserId, userId), eq(transfers.recipientUserId, userId));
}

function parseCursor(cursor: string): { at: string; id: string } {
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw errors.validation('Invalid cursor.');
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(decoded).toString('base64url') !== cursor) throw errors.validation('Invalid cursor.');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(decoded);
  if (!match || !Number.isFinite(Date.parse(match[1])) ||
      new Date(match[1]).toISOString().slice(0, 23) !== match[1].slice(0, 23)) {
    throw errors.validation('Invalid cursor.');
  }
  return { at: match[1], id: match[2] };
}

async function serialize(row: JoinedRow, userId: string, prices: Map<string, string | null>): Promise<TransferDto> {
  const transfer = row.transfer;
  const sent = transfer.senderUserId === userId;
  const price = prices.get(row.token.address) ?? null;
  const minRaw = await getMinAmountRaw(row.token, price);
  return {
    id: transfer.id,
    direction: sent ? 'sent' : 'received',
    txHash: transfer.txHash as `0x${string}`,
    status: transfer.status,
    token: toTokenDto(row.token, price, minRaw),
    amountRaw: transfer.amountRaw,
    amount: formatAmount(transfer.amountRaw, row.token.decimals),
    from: {
      address: checksum(transfer.senderAddress), displayName: row.senderName || null,
      phoneMasked: null, isMe: sent,
    },
    to: {
      address: checksum(transfer.recipientAddress), displayName: row.recipientName || null,
      phoneMasked: sent ? transfer.recipientPhoneMasked : null,
      isMe: transfer.recipientUserId === userId,
    },
    contactName: sent ? transfer.contactName : null,
    intentId: transfer.intentId,
    explorerUrl: explorerTx(transfer.txHash),
    createdAt: row.createdExact,
    confirmedAt: transfer.confirmedAt?.toISOString() ?? null,
  };
}

export async function getTransfer(userId: string, id: string): Promise<TransferDto> {
  const [row] = await joined().where(and(eq(transfers.id, id), visibleTo(userId, 'all'))).limit(1);
  if (!row) throw errors.notFound();
  return serialize(row, userId, await getPrices());
}

export async function listTransfers(userId: string, opts: {
  direction: Direction; limit: number; cursor?: string;
}): Promise<{ items: TransferDto[]; nextCursor: string | null }> {
  const cursor = opts.cursor ? parseCursor(opts.cursor) : null;
  const rows = await joined().where(and(
    visibleTo(userId, opts.direction),
    cursor ? or(
      lt(transfers.createdAt, sql`${cursor.at}::timestamptz`),
      and(eq(transfers.createdAt, sql`${cursor.at}::timestamptz`), lt(transfers.id, cursor.id)),
    ) : undefined,
  )).orderBy(sql`${transfers.createdAt} DESC`, sql`${transfers.id} DESC`).limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const prices = page.length ? await getPrices() : new Map<string, string | null>();
  const items = await Promise.all(page.map((row) => serialize(row, userId, prices)));
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.length > opts.limit && last
      ? Buffer.from(`${last.createdExact}|${last.transfer.id}`).toString('base64url') : null,
  };
}

function csvField(value: string): string {
  // Spreadsheet applications can execute formulas even in quoted CSV cells.
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function exportCsv(userId: string, direction: Direction): Readable {
  async function* lines() {
    yield ['Date', 'Direction', 'Status', 'Token', 'Amount', 'From', 'To', 'Tx hash', 'Explorer URL']
      .map(csvField).join(',') + '\r\n';
    let cursor: string | undefined;
    let exported = 0;
    do {
      const page = await listTransfers(userId, { direction, limit: Math.min(100, 5000 - exported), cursor });
      for (const item of page.items) {
        yield [item.createdAt, item.direction, item.status, item.token.symbol, item.amount,
          item.from.address, item.to.address, item.txHash, item.explorerUrl].map(csvField).join(',') + '\r\n';
      }
      exported += page.items.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor && exported < 5000);
  }
  return Readable.from(lines());
}
