import { and, eq, gt, inArray, lte, lt } from 'drizzle-orm';
import { decodeEventLog, type Log } from 'viem';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { notify } from '../../db/notify.js';
import { escrows, tokens, transfers, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { normAddress } from '../../lib/chain.js';
import { decrypt } from '../../lib/crypto.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatAmount } from '../../lib/money.js';
import { normalizePhone } from '../../lib/phone.js';
import { consume, limits, peek } from '../../lib/rateLimit.js';
import { pingRouterAbi } from '../../lib/router.js';
import { sendSms, SmsDeliveryError, type SmsOutcome, type SmsProvider } from '../../lib/sms.js';
import { smsAmount } from '../intents/service.js';
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
      depositedAt: minedAt, smsStatus: row.deliveryMode === 'claim' ? 'deferred_budget' : 'not_required',
      smsNextAttemptAt: row.deliveryMode === 'claim' ? minedAt : null }).where(eq(escrows.id, row.id));
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

export async function sendEscrowInvite(id: string, provider?: SmsProvider): Promise<void> {
  const row = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const now = new Date();
    const [candidate] = await tx.select({ escrow: escrows, token: tokens }).from(escrows)
      .innerJoin(tokens, eq(tokens.address, escrows.tokenAddress))
      .where(and(eq(escrows.id, id), eq(escrows.deliveryMode, 'claim'), eq(escrows.status, 'deposited'),
        gt(escrows.expiresAt, now), inArray(escrows.smsStatus,
          ['deferred_budget', 'deferred_rate_limit', 'provider_rejected', 'disabled']),
        lte(escrows.smsNextAttemptAt, now), lt(escrows.smsAttemptCount, MAX_PROVIDER_ATTEMPTS)))
      .limit(1);
    if (!candidate) return null;
    const phone = normalizePhone(decrypt(candidate.escrow.recipientPhoneEnc));
    const text = `PingApp: You received ${smsAmount(formatAmount(candidate.escrow.amountRaw, candidate.token.decimals))} ${candidate.token.symbol}. Claim it by linking a wallet: ${config.APP_URL.replace(/\/$/, '')}/claim/${candidate.escrow.code}`;
    const [claimed] = await tx.update(escrows).set({ smsStatus: 'provider_unknown', smsNextAttemptAt: null })
      .where(and(eq(escrows.id, id), eq(escrows.deliveryMode, 'claim'), eq(escrows.status, 'deposited'),
        gt(escrows.expiresAt, now), inArray(escrows.smsStatus,
          ['deferred_budget', 'deferred_rate_limit', 'provider_rejected', 'disabled']),
        lte(escrows.smsNextAttemptAt, now), lt(escrows.smsAttemptCount, MAX_PROVIDER_ATTEMPTS)))
      .returning({ id: escrows.id });
    if (!claimed) return null;
    return { ...candidate, phone, text };
  });
  if (!row) return;

  let outcome: SmsOutcome = 'provider_unknown';
  let retryAfterMs: number | undefined;
  try {
    await sendSms({ purpose: 'intent', budgetLane: 'funded_invite', toE164: row.phone.e164,
      phoneHmac: row.escrow.recipientPhoneHmac, country: row.phone.country, text: row.text }, {
      provider,
      beforeProvider: async () => {
        const [eligible] = await db.select({ id: escrows.id }).from(escrows).where(and(
          eq(escrows.id, id), eq(escrows.deliveryMode, 'claim'), eq(escrows.status, 'deposited'),
          gt(escrows.expiresAt, new Date()),
        )).limit(1);
        if (!eligible) throw new SmsDeliveryError('not_required');
        await reserveInvitePhoneLimits(row.escrow.recipientPhoneHmac);
      },
    });
    outcome = 'sent';
  } catch (error) {
    if (error instanceof SmsDeliveryError) {
      outcome = error.outcome;
      retryAfterMs = error.retryAfterMs;
    } else {
      // An unexpected exception after the attempt was claimed is ambiguous; never auto-send it again.
      outcome = 'provider_unknown';
    }
    logger.warn({ escrowId: id, outcome }, 'escrow invite SMS did not complete; funds remain available');
  }

  const now = new Date();
  const nextAttemptCount = row.escrow.smsAttemptCount +
    (outcome === 'sent' || outcome === 'provider_rejected' || outcome === 'provider_unknown' ? 1 : 0);
  let smsStatus: string;
  let smsNextAttemptAt: Date | null = null;
  if (outcome === 'sent') {
    smsStatus = 'sent';
  } else if (outcome === 'provider_rejected') {
    smsStatus = outcome;
    const delay = REJECTED_BACKOFF_MS[nextAttemptCount - 1];
    if (delay !== undefined && nextAttemptCount < MAX_PROVIDER_ATTEMPTS) smsNextAttemptAt = new Date(now.getTime() + delay);
  } else if (outcome === 'provider_unknown') {
    smsStatus = outcome;
  } else if (outcome === 'not_required') {
    smsStatus = 'not_required';
  } else if (outcome === 'disabled') {
    smsStatus = outcome;
    smsNextAttemptAt = new Date(now.getTime() + (retryAfterMs ?? PRE_PROVIDER_RETRY_MS));
  } else {
    smsStatus = outcome;
    smsNextAttemptAt = new Date(now.getTime() + (retryAfterMs ?? PRE_PROVIDER_RETRY_MS));
  }
  await db.update(escrows).set({ smsStatus, smsAttemptCount: nextAttemptCount, smsNextAttemptAt })
    .where(and(eq(escrows.id, id), eq(escrows.smsStatus, 'provider_unknown')));
}

const MAX_PROVIDER_ATTEMPTS = 3;
const REJECTED_BACKOFF_MS = [15 * 60_000, 60 * 60_000];
const PRE_PROVIDER_RETRY_MS = 5 * 60_000;

async function reserveInvitePhoneLimits(phoneHash: string): Promise<void> {
  const [daily, rolling] = await Promise.all([
    peek(limits.intentPhoneSmsDay, phoneHash), peek(limits.intentPhoneSms30d, phoneHash),
  ]);
  const exhausted = [daily, rolling].filter((bucket) => bucket.remaining <= 0);
  if (exhausted.length) throw errors.rateLimited(Math.max(...exhausted.map((bucket) => bucket.resetSec)));
  await consume(limits.intentPhoneSmsDay, phoneHash);
  await consume(limits.intentPhoneSms30d, phoneHash);
}
