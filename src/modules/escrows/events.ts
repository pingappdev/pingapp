import { and, eq, inArray } from 'drizzle-orm';
import { decodeEventLog, type Log } from 'viem';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { kvGet, kvSet } from '../../db/kv.js';
import { notify } from '../../db/notify.js';
import { escrows, tokens, transfers, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { normAddress } from '../../lib/chain.js';
import { decrypt } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatAmount } from '../../lib/money.js';
import { normalizePhone } from '../../lib/phone.js';
import { consume, limits } from '../../lib/rateLimit.js';
import { pingRouterAbi } from '../../lib/router.js';
import { sendSms } from '../../lib/sms.js';
import { smsAmount, smsName } from '../intents/service.js';
import { lockPhoneMutation } from '../phone/lock.js';
import { markEscrowsClaimable } from './ready.js';

/** Caller takes lockPhoneMutation first. Returns newly deposited ids for post-commit SMS. */
export async function applyRouterLog(tx: DbTransaction, log: Log, minedAt: Date): Promise<string | null> {
  if (normAddress(log.address) !== normAddress(config.ROUTER_ADDRESS) || !log.transactionHash) return null;
  let event;
  try { event = decodeEventLog({ abi: pingRouterAbi, data: log.data, topics: log.topics }); } catch { return null; }
  if (event.eventName !== 'Escrowed' && event.eventName !== 'Claimed' && event.eventName !== 'Refunded') return null;
  const [row] = await tx.select().from(escrows).where(eq(escrows.id, event.args.id)).limit(1).for('update');
  if (!row) return null; // Only PingApp's persisted phone/id mappings are recognized.
  const hash = log.transactionHash.toLowerCase();
  if (event.args.token.toLowerCase() !== row.tokenAddress || event.args.claimTip !== BigInt(row.claimTipWei)) return null;
  if (event.eventName === 'Escrowed') {
    const a = event.args;
    if (a.sender.toLowerCase() !== row.senderAddress || a.fee !== BigInt(row.feeWei) ||
        a.expiresAt * 1000n !== BigInt(row.expiresAt.getTime()) || a.amount <= 0n) return null;
    if (!['authorized', 'void'].includes(row.status)) return null;
    await tx.update(escrows).set({ status: 'deposited', amountRaw: a.amount.toString(), depositTxHash: hash,
      depositedAt: minedAt }).where(eq(escrows.id, row.id));
    const [recipient] = await tx.select({ id: users.id }).from(users).where(eq(users.phoneHmac, row.recipientPhoneHmac)).limit(1);
    if (recipient) await markEscrowsClaimable(tx, row.recipientPhoneHmac, recipient.id);
    return row.id;
  }
  if (event.args.amount !== BigInt(row.amountRaw)) return null;
  if (event.eventName === 'Claimed') {
    if (row.status === 'claimed' || row.status === 'refunded') return null;
    await tx.update(escrows).set({ status: 'claimed', claimTxHash: hash,
      claimedToAddress: normAddress(event.args.recipient), claimedAt: minedAt }).where(eq(escrows.id, row.id));
    const [actualRecipient] = await tx.select({ id: users.id }).from(users)
      .where(eq(users.address, normAddress(event.args.recipient))).limit(1);
    await tx.insert(transfers).values({
      senderUserId: row.senderUserId, senderAddress: row.senderAddress,
      recipientUserId: actualRecipient?.id ?? null, recipientAddress: normAddress(event.args.recipient),
      recipientPhoneHmac: row.recipientPhoneHmac, recipientPhoneMasked: row.recipientPhoneMasked,
      tokenAddress: row.tokenAddress, amountRaw: event.args.amount.toString(), routerId: row.id,
      contactName: row.contactName, txHash: hash, status: 'confirmed', blockNumber: log.blockNumber,
      confirmedAt: minedAt,
    }).onConflictDoNothing();
    if (row.senderUserId) await notify(row.senderUserId, 'escrow_claimed', { escrowId: row.id }, tx);
    if (actualRecipient) await notify(actualRecipient.id, 'escrow_received', { escrowId: row.id }, tx);
  } else {
    if (event.args.sender.toLowerCase() !== row.senderAddress || ['claimed', 'refunded'].includes(row.status)) return null;
    await tx.update(escrows).set({ status: 'refunded', refundTxHash: hash, refundedAt: minedAt }).where(eq(escrows.id, row.id));
    if (row.senderUserId) await notify(row.senderUserId, 'escrow_refunded', { escrowId: row.id }, tx);
  }
  return null;
}

export async function sendEscrowInvite(id: string): Promise<void> {
  const row = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const [joined] = await tx.select({ escrow: escrows, token: tokens, name: users.displayName }).from(escrows)
      .innerJoin(tokens, eq(tokens.address, escrows.tokenAddress)).leftJoin(users, eq(users.id, escrows.senderUserId))
      .where(and(eq(escrows.id, id), eq(escrows.deliveryMode, 'claim'),
        inArray(escrows.status, ['deposited', 'claiming']), eq(escrows.smsStatus, 'failed'))).limit(1);
    if (!joined || await kvGet<boolean>(`router:sms-attempted:${id}`, tx)) return null;
    // Never duplicate an SMS whose provider outcome became uncertain after a crash.
    await kvSet(`router:sms-attempted:${id}`, true, tx);
    return joined;
  });
  if (!row) return;
  let smsStatus = 'sent';
  try {
    await consume(limits.intentPhoneSmsDay, row.escrow.recipientPhoneHmac);
    await consume(limits.intentPhoneSms30d, row.escrow.recipientPhoneHmac);
    const phone = normalizePhone(decrypt(row.escrow.recipientPhoneEnc));
    await sendSms({ purpose: 'intent', toE164: phone.e164, phoneHmac: row.escrow.recipientPhoneHmac, country: phone.country,
      text: `PingApp: ${smsName(row.name || '')} sent you ${smsAmount(formatAmount(row.escrow.amountRaw, row.token.decimals))} ${row.token.symbol}. Claim it by linking a wallet: ${config.APP_URL.replace(/\/$/, '')}/claim/${row.escrow.code}` });
  } catch (error) {
    smsStatus = error instanceof AppError && error.code === 'RATE_LIMITED' ? 'skipped_rate_limit'
      : error instanceof AppError && error.details?.smsReason === 'disabled' ? 'disabled' : 'failed';
    logger.warn({ escrowId: id, smsStatus }, 'escrow invite SMS failed; funds remain available');
  }
  await db.update(escrows).set({ smsStatus }).where(eq(escrows.id, id));
}
