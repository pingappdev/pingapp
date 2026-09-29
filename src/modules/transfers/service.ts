import { and, eq, gt, inArray } from 'drizzle-orm';
import { decodeEventLog, erc20Abi, TransactionReceiptNotFoundError, type TransactionReceipt } from 'viem';
import { db } from '../../db/client.js';
import { audit } from '../../db/audit.js';
import { notify } from '../../db/notify.js';
import { contacts, intents, transfers, users, type Transfer } from '../../db/schema.js';
import { isAddress, NATIVE_TOKEN, normAddress } from '../../lib/chain.js';
import { invalidate } from '../../lib/cache.js';
import { phoneHmac } from '../../lib/crypto.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatAmount } from '../../lib/money.js';
import { enqueue } from '../../lib/queue.js';
import { normalizePhone } from '../../lib/phone.js';
import { publicClient } from '../../lib/viem.js';
import { assertMinAmount } from '../tokens/minimum.js';
import { getToken } from '../tokens/registry.js';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW_AMOUNT = /^[1-9]\d{0,77}$/;
const INTENT_MISMATCH = "This transfer doesn't match the pending send.";

export type TransferBody = {
  txHash: string;
  tokenAddress: string;
  amountRaw: string;
  toAddress: string;
  recipientPhone?: string;
  contactId?: string;
  intentId?: string;
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
  if (!HASH.test(body.txHash)) throw errors.validation('Enter a valid transaction hash.');
  if (!RAW_AMOUNT.test(body.amountRaw)) throw errors.invalidAmount();
  if (!isAddress(body.toAddress)) throw errors.invalidAddress();
  const toAddress = normAddress(body.toAddress);
  if (toAddress === normAddress(user.address)) throw errors.selfSend();
  const token = await getToken(body.tokenAddress);
  if (!token) throw errors.unknownToken();
  const hash = body.txHash.toLowerCase();

  const prior = await byHash(hash);
  if (prior) return { row: sameSender(prior, user.id), created: false };

  // Enforce the API contract for every recorded send, including intent completions.
  await assertMinAmount(token, BigInt(body.amountRaw), { tolerancePct: 10 });
  const phone = body.recipientPhone === undefined ? null : normalizePhone(body.recipientPhone);
  const recipientPhoneHmac = phone ? phoneHmac(phone.e164) : null;

  const result = await db.transaction(async (tx) => {
    // Locking the recipient first matches phone-linking's update order. It prevents
    // recording a stale phone or intent binding while that account changes phone.
    const [recipient] = await tx.select().from(users)
      .where(eq(users.address, toAddress)).limit(1).for('update');
    if (recipientPhoneHmac && recipient?.phoneHmac !== recipientPhoneHmac) {
      throw errors.validation('This phone number no longer points to that wallet. Please review the recipient again.');
    }

    let contactName: string | null = null;
    if (body.contactId) {
      const [contact] = await tx.select({ name: contacts.name }).from(contacts)
        .where(and(eq(contacts.id, body.contactId), eq(contacts.userId, user.id))).limit(1);
      if (!contact) throw errors.validation('This contact is unavailable.');
      contactName = contact.name;
    }

    if (body.intentId) {
      const [intent] = await tx.select().from(intents)
        .where(eq(intents.id, body.intentId)).limit(1).for('update');
      // A competing POST for this hash may have committed while we waited for the intent.
      const [committed] = await tx.select().from(transfers).where(eq(transfers.txHash, hash)).limit(1);
      if (committed) return { row: sameSender(committed, user.id), created: false };
      if (!intent || intent.senderUserId !== user.id || intent.status !== 'ready' ||
          intent.expiresAt <= new Date() || intent.tokenAddress !== token.address ||
          intent.amountRaw !== body.amountRaw || intent.recipientUserId !== recipient?.id ||
          recipient?.phoneHmac !== intent.recipientPhoneHmac) {
        throw errors.validation(INTENT_MISMATCH);
      }
      const [active] = await tx.select({ id: transfers.id }).from(transfers)
        .where(and(eq(transfers.intentId, intent.id), inArray(transfers.status, ['submitted', 'confirmed'])))
        .limit(1);
      if (active) throw errors.validation(INTENT_MISMATCH);
    }

    const [inserted] = await tx.insert(transfers).values({
      senderUserId: user.id,
      senderAddress: normAddress(user.address),
      recipientAddress: toAddress,
      recipientUserId: recipient?.id ?? null,
      recipientPhoneHmac,
      recipientPhoneMasked: phone?.masked ?? null,
      tokenAddress: token.address,
      amountRaw: body.amountRaw,
      txHash: hash,
      status: 'submitted',
      contactName,
      intentId: body.intentId ?? null,
    }).onConflictDoNothing({ target: transfers.txHash }).returning();
    if (!inserted) {
      const [existing] = await tx.select().from(transfers).where(eq(transfers.txHash, hash)).limit(1);
      if (!existing) throw errors.internal();
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

function hasExactTransferLog(receipt: TransactionReceipt, row: Transfer): boolean {
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
    const [updated] = await tx.update(transfers).set({
      status, blockNumber: receipt.blockNumber, confirmedAt: new Date(),
    }).where(and(eq(transfers.id, row.id), eq(transfers.status, 'submitted')))
      .returning({ id: transfers.id });
    if (!updated) return false;

    if (status === 'failed' && row.senderUserId) {
      await notify(row.senderUserId, 'transfer_failed', { transferId: row.id, amount, symbol: tokenRow.symbol }, tx);
    }
    if (status === 'confirmed') {
      if (row.recipientUserId) {
        const [sender] = await tx.select({ name: users.displayName }).from(users)
          .where(eq(users.id, row.senderUserId ?? '')).limit(1);
        await notify(row.recipientUserId, 'transfer_received', {
          transferId: row.id,
          senderDisplayName: displayName(sender?.name, row.senderAddress),
          amount, symbol: tokenRow.symbol,
        }, tx);
      }
      if (row.intentId && row.recipientUserId) {
        // Phone changes reset ready intents. The extra current-binding and expiry
        // guards prevent a late receipt from completing a stale intent.
        const [recipient] = await tx.select({ phoneHmac: users.phoneHmac }).from(users)
          .where(eq(users.id, row.recipientUserId)).limit(1);
        if (recipient?.phoneHmac) {
          await tx.update(intents).set({ status: 'completed', transferId: row.id, completedAt: new Date() })
            .where(and(eq(intents.id, row.intentId), eq(intents.status, 'ready'),
              eq(intents.recipientUserId, row.recipientUserId),
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
  if (row.tokenAddress === NATIVE_TOKEN) {
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
