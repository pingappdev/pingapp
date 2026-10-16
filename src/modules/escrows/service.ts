import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import { config } from '../../config.js';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { kvGet, kvSet } from '../../db/kv.js';
import { claimAuthorizations, escrows, phoneClaims, tokens, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { checksum, normAddress } from '../../lib/chain.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatAmount } from '../../lib/money.js';
import { enqueue } from '../../lib/queue.js';
import { getRelayerAccount, hashClaimAuth, routerDomain, serializeRouterAuth, signClaimAuth, type ClaimAuth } from '../../lib/router.js';
import { publicClient } from '../../lib/viem.js';
import type { AuthUser } from '../../plugins/auth.js';
import { lockPhoneMutation } from '../phone/lock.js';
import { getMinAmountRaw } from '../tokens/minimum.js';
import { getPrices } from '../tokens/prices.js';
import { toTokenDto } from '../tokens/routes.js';
import { matchesEscrowRecipient } from './ready.js';
import { assertRouterOperationEnabled, isRouterIncidentStop } from './incident.js';

export type ClaimJob = {
  requestId?: string;
  auth: { id: Hex; recipient: Hex; relayer: Hex; deadline: string };
  signature: Hex;
};
export const claimJobKey = (id: string) => `router:claim:${id}`;
/** Set when a relayed claim would exceed RELAY_CLAIM_MAX_GAS; the recipient then submits it. */
export const selfClaimKey = (id: string) => `router:self-claim:${id}`;

export async function submittedEscrow(user: AuthUser, id: string, txHash: string) {
  if (!config.ROUTER_ADDRESS) throw errors.conflict('Router is not configured.');
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
  await enqueue('escrows', 'relay', job, {
    jobId: `relay-${job.requestId ?? `${job.auth.id}-${job.auth.deadline}`}${suffix}`,
  });
}

/** Only callers holding the phone lock with a verified deposit may sign a payout. */
function claimAuthFor(escrow: typeof escrows.$inferSelect, recipient: typeof users.$inferSelect, relayer: Hex): ClaimAuth {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: escrow.id as Hex, recipient: normAddress(recipient.address), relayer,
    deadline: BigInt(Math.min(now + 600, Math.floor(escrow.expiresAt.getTime() / 1000) - 1)),
  };
}

async function prepareClaim(tx: DbTransaction, escrow: typeof escrows.$inferSelect, recipient: typeof users.$inferSelect,
  ipHash?: string): Promise<ClaimJob> {
  await assertRouterOperationEnabled('claim-signatures', tx);
  if (!recipient.phoneHmac) throw errors.conflict('This recipient is no longer bound to the escrow phone.');
  const auth = claimAuthFor(escrow, recipient, getRelayerAccount().address);
  const requestId = randomUUID();
  const signedAt = new Date();
  await tx.insert(claimAuthorizations).values({
    requestId,
    escrowId: auth.id,
    kind: 'relayed',
    recipientUserId: recipient.id,
    recipientAddress: auth.recipient,
    relayerAddress: auth.relayer,
    recipientPhoneHmac: recipient.phoneHmac,
    phoneLinkedAt: recipient.phoneLinkedAt,
    deadline: new Date(Number(auth.deadline) * 1000),
    domainName: routerDomain.name,
    domainVersion: routerDomain.version,
    domainChainId: BigInt(routerDomain.chainId),
    domainVerifyingContract: routerDomain.verifyingContract,
    typedDataDigest: hashClaimAuth(auth),
    signedAt,
  });
  // Check again after DB writes and immediately before asking the signer.
  await assertRouterOperationEnabled('claim-signatures', tx);
  const signature = await signClaimAuth(auth);
  const job: ClaimJob = { requestId, auth: serializeRouterAuth(auth), signature };
  await tx.update(escrows).set({ status: 'claiming', claimTxHash: null, recipientUserId: recipient.id })
    .where(eq(escrows.id, escrow.id));
  // Durable outbox closes the DB-commit/BullMQ-enqueue crash window.
  await kvSet(claimJobKey(escrow.id), job, tx);
  await audit('escrow_claim_requested', { userId: recipient.id, data: { escrowId: escrow.id, requestId }, ipHash }, tx);
  return job;
}

async function dispatchClaim(job: ClaimJob): Promise<void> {
  try { await enqueueClaim(job); } catch {
    logger.warn({ escrowId: job.auth.id }, 'claim saved; indexer will retry relay enqueue');
  }
}

/** Runs after deposit commit and during index recovery; never returns a claim signature to a caller. */
export async function claimRegisteredEscrow(id: string): Promise<void> {
  try { await assertRouterOperationEnabled('claim-signatures'); } catch (error) {
    if (isRouterIncidentStop(error)) return;
    throw error;
  }
  let job: ClaimJob | null;
  try {
    job = await db.transaction(async (tx) => {
      await lockPhoneMutation(tx);
      const [escrow] = await tx.select().from(escrows).where(eq(escrows.id, id)).limit(1).for('update');
      if (!escrow || escrow.deliveryMode !== 'automatic' || escrow.status !== 'deposited' ||
          !escrow.depositedAt || !escrow.depositTxHash || escrow.expiresAt.getTime() <= Date.now() + 300_000) return null;
      const [recipient] = await tx.select().from(users).where(eq(users.phoneHmac, escrow.recipientPhoneHmac)).limit(1);
      if (!recipient || !matchesEscrowRecipient(escrow, recipient)) return null;
      const [dispute] = await tx.select({ id: phoneClaims.id }).from(phoneClaims).where(and(
        eq(phoneClaims.phoneHmac, escrow.recipientPhoneHmac), eq(phoneClaims.status, 'pending_review'),
      )).limit(1);
      if (dispute || await kvGet<boolean>(selfClaimKey(escrow.id), tx)) return null;
      return prepareClaim(tx, escrow, recipient);
    });
  } catch (error) {
    if (isRouterIncidentStop(error)) return;
    throw error;
  }
  if (job) await dispatchClaim(job);
}

/** Caller holds lockPhoneMutation. Returns the locked escrow and the caller's user row. */
async function lockClaimableEscrow(tx: DbTransaction, user: AuthUser, id: string) {
  const [escrow] = await tx.select().from(escrows).where(eq(escrows.id, id)).limit(1).for('update');
  const [me] = await tx.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!escrow || !me || escrow.recipientUserId !== user.id || !matchesEscrowRecipient(escrow, me) ||
      normAddress(me.address) !== normAddress(user.address) || escrow.senderUserId === user.id ||
      escrow.senderAddress === normAddress(user.address)) throw errors.forbidden();
  const [dispute] = await tx.select({ id: phoneClaims.id }).from(phoneClaims).where(and(
    eq(phoneClaims.phoneHmac, escrow.recipientPhoneHmac), eq(phoneClaims.status, 'pending_review'),
  )).limit(1);
  if (dispute) throw errors.claimPending();
  const now = Math.floor(Date.now() / 1000);
  if (escrow.status !== 'deposited' || !escrow.depositedAt || !escrow.depositTxHash ||
      escrow.expiresAt.getTime() <= (now + 300) * 1000) {
    throw errors.conflict('This escrow is not currently claimable.');
  }
  return { escrow, me };
}

export async function claimEscrow(user: AuthUser, id: string, ipHash: string) {
  await assertRouterOperationEnabled('claim-signatures');
  const job = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const { escrow, me } = await lockClaimableEscrow(tx, user, id);
    if (await kvGet<boolean>(selfClaimKey(escrow.id), tx)) {
      throw errors.conflict('This payout needs more gas than the relayer covers. Claim it from your wallet on the Requests page.');
    }
    return prepareClaim(tx, escrow, me, ipHash);
  });
  await dispatchClaim(job);
  return { id, status: 'claiming' as const };
}

/**
 * Signs a claim the recipient submits and pays gas for (relayer = recipient), only
 * after the relayer refused it for exceeding RELAY_CLAIM_MAX_GAS. The signature can
 * only pay the caller's own bound wallet and expires within ten minutes.
 */
export async function selfClaimEscrow(user: AuthUser, id: string, ipHash: string) {
  await assertRouterOperationEnabled('claim-signatures');
  return db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const { escrow, me } = await lockClaimableEscrow(tx, user, id);
    if (!await kvGet<boolean>(selfClaimKey(escrow.id), tx)) {
      throw errors.conflict('This payout is delivered by the relayer.');
    }
    if (!me.phoneHmac) throw errors.conflict('This recipient is no longer bound to the escrow phone.');
    const auth = claimAuthFor(escrow, me, normAddress(me.address));
    const requestId = randomUUID();
    const signedAt = new Date();
    await tx.insert(claimAuthorizations).values({
      requestId,
      escrowId: auth.id,
      kind: 'self',
      recipientUserId: me.id,
      recipientAddress: auth.recipient,
      relayerAddress: auth.relayer,
      recipientPhoneHmac: me.phoneHmac,
      phoneLinkedAt: me.phoneLinkedAt,
      deadline: new Date(Number(auth.deadline) * 1000),
      domainName: routerDomain.name,
      domainVersion: routerDomain.version,
      domainChainId: BigInt(routerDomain.chainId),
      domainVerifyingContract: routerDomain.verifyingContract,
      typedDataDigest: hashClaimAuth(auth),
      signedAt,
    });
    await audit('escrow_self_claim_signed', {
      userId: me.id,
      data: { escrowId: escrow.id, requestId },
      ipHash,
    }, tx);
    await assertRouterOperationEnabled('claim-signatures', tx);
    const signature = await signClaimAuth(auth);
    return { router: normAddress(config.ROUTER_ADDRESS), auth: serializeRouterAuth(auth), signature };
  });
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
  const chainTime = config.ROUTER_ADDRESS && rows.length ? Number((await publicClient.getBlock()).timestamp) * 1000 : Date.now();
  return Promise.all(rows.map(async ({ escrow: row, token, senderName }) => {
    const price = prices.get(token.address) ?? null;
    return {
      id: row.id, code: row.code, status: row.status, smsStatus: row.smsStatus, deliveryMode: row.deliveryMode,
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
      selfClaim: role === 'incoming' && row.status === 'deposited' && !!await kvGet<boolean>(selfClaimKey(row.id)),
    };
  }));
}
