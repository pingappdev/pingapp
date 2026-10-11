import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Hex } from 'viem';
import { config } from '../../config.js';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { kvSet } from '../../db/kv.js';
import { escrows, phoneClaims, tokens, users } from '../../db/schema.js';
import { checksum, normAddress } from '../../lib/chain.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatAmount } from '../../lib/money.js';
import { enqueue } from '../../lib/queue.js';
import { getRelayerAccount, serializeRouterAuth, signClaimAuth, type ClaimAuth } from '../../lib/router.js';
import { publicClient } from '../../lib/viem.js';
import type { AuthUser } from '../../plugins/auth.js';
import { lockPhoneMutation } from '../phone/lock.js';
import { getMinAmountRaw } from '../tokens/minimum.js';
import { getPrices } from '../tokens/prices.js';
import { toTokenDto } from '../tokens/routes.js';

export type ClaimJob = {
  auth: { id: Hex; recipient: Hex; relayer: Hex; deadline: string };
  signature: Hex;
};
export const claimJobKey = (id: string) => `router:claim:${id}`;

export async function submittedEscrow(user: AuthUser, id: string, txHash: string) {
  if (!config.ROUTER_ENABLED) throw errors.conflict('Router sends are not enabled.');
  const row = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const [escrow] = await tx.select().from(escrows).where(eq(escrows.id, id)).limit(1).for('update');
    if (!escrow || escrow.senderUserId !== user.id || escrow.senderAddress !== normAddress(user.address)) throw errors.forbidden();
    if (escrow.depositTxHash && escrow.depositTxHash !== txHash) throw errors.conflict('This escrow already has a submitted transaction.');
    if (!escrow.depositTxHash) await tx.update(escrows).set({ depositTxHash: txHash }).where(eq(escrows.id, id));
    return escrow;
  });
  await enqueue('escrows', 'confirm', { escrowId: id, attempt: 0 }, { delay: 4000, jobId: `confirm-${id}-0` });
  return { id, status: row.status, depositTxHash: txHash };
}

export async function enqueueClaim(job: ClaimJob, suffix = ''): Promise<void> {
  await enqueue('escrows', 'relay', job, { jobId: `relay-${job.auth.id}-${job.auth.deadline}${suffix}` });
}

export async function claimEscrow(user: AuthUser, id: string, ipHash: string) {
  if (!config.ROUTER_ENABLED) throw errors.conflict('Escrow claiming is not enabled.');
  const job = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const [escrow] = await tx.select().from(escrows).where(eq(escrows.id, id)).limit(1).for('update');
    const [me] = await tx.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!escrow || !me || escrow.recipientUserId !== user.id || me.phoneHmac !== escrow.recipientPhoneHmac ||
        normAddress(me.address) !== normAddress(user.address) || escrow.senderUserId === user.id ||
        escrow.senderAddress === normAddress(user.address)) throw errors.forbidden();
    const [dispute] = await tx.select({ id: phoneClaims.id }).from(phoneClaims).where(and(
      eq(phoneClaims.phoneHmac, escrow.recipientPhoneHmac), eq(phoneClaims.status, 'pending_review'),
    )).limit(1);
    if (dispute) throw errors.claimPending();
    const now = Math.floor(Date.now() / 1000);
    if (escrow.status !== 'deposited' || escrow.expiresAt.getTime() <= (now + 300) * 1000) {
      throw errors.conflict('This escrow is not currently claimable.');
    }
    const auth: ClaimAuth = {
      id: escrow.id as Hex, recipient: normAddress(user.address), relayer: getRelayerAccount().address,
      deadline: BigInt(Math.min(now + 600, Math.floor(escrow.expiresAt.getTime() / 1000) - 1)),
    };
    const signature = await signClaimAuth(auth);
    const job: ClaimJob = { auth: serializeRouterAuth(auth), signature };
    await tx.update(escrows).set({ status: 'claiming', claimTxHash: null }).where(eq(escrows.id, id));
    // Durable outbox closes the DB-commit/BullMQ-enqueue crash window.
    await kvSet(claimJobKey(id), job, tx);
    await audit('escrow_claim_requested', { userId: user.id, data: { escrowId: id }, ipHash }, tx);
    return job;
  });
  try { await enqueueClaim(job); } catch {
    logger.warn({ escrowId: id }, 'claim saved; indexer will retry relay enqueue');
  }
  return { id, status: 'claiming' as const };
}

export async function listEscrows(userId: string, role: 'sent' | 'incoming') {
  const rows = await db.select({ escrow: escrows, token: tokens, senderName: users.displayName }).from(escrows)
    .innerJoin(tokens, eq(tokens.address, escrows.tokenAddress))
    .leftJoin(users, eq(users.id, escrows.senderUserId)).where(role === 'sent'
      ? eq(escrows.senderUserId, userId)
      : and(eq(escrows.recipientUserId, userId), inArray(escrows.status, ['deposited', 'claiming', 'claimed'])))
    .orderBy(desc(escrows.createdAt)).limit(100);
  const prices = rows.length ? await getPrices() : new Map<string, string | null>();
  // Refund eligibility follows chain time, including local fork time travel.
  const chainTime = config.ROUTER_ENABLED && rows.length ? Number((await publicClient.getBlock()).timestamp) * 1000 : Date.now();
  return Promise.all(rows.map(async ({ escrow: row, token, senderName }) => {
    const price = prices.get(token.address) ?? null;
    return {
      id: row.id, code: row.code, status: row.status, smsStatus: row.smsStatus,
      recipientPhoneMasked: role === 'sent' ? row.recipientPhoneMasked : null,
      sender: { address: checksum(row.senderAddress), displayName: senderName || `${row.senderAddress.slice(0, 6)}…${row.senderAddress.slice(-4)}` },
      token: toTokenDto(token, price, await getMinAmountRaw(token, price)),
      amountRaw: row.amountRaw, amount: formatAmount(row.amountRaw, token.decimals),
      claimTipWei: row.claimTipWei, feeWei: row.feeWei, note: row.note,
      claimUrl: `${config.APP_URL.replace(/\/$/, '')}/claim/${row.code}`,
      expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
      depositedAt: row.depositedAt?.toISOString() ?? null, claimedAt: row.claimedAt?.toISOString() ?? null,
      refundedAt: row.refundedAt?.toISOString() ?? null, depositTxHash: row.depositTxHash,
      claimTxHash: row.claimTxHash, refundTxHash: row.refundTxHash,
      refundable: ['deposited', 'claiming'].includes(row.status) && row.expiresAt.getTime() <= chainTime,
    };
  }));
}
