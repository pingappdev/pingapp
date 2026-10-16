import { and, eq, inArray, lt } from 'drizzle-orm';
import { BaseError, ContractFunctionRevertedError, createWalletClient, custom, type Hex } from 'viem';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { kvGet, kvSet } from '../../db/kv.js';
import { notify } from '../../db/notify.js';
import { escrows, kv, phoneClaims, users } from '../../db/schema.js';
import { normAddress, viemChain } from '../../lib/chain.js';
import { invalidate } from '../../lib/cache.js';
import { logger } from '../../lib/logger.js';
import type { WorkerCtx } from '../../lib/modules.js';
import { enqueue, getQueue } from '../../lib/queue.js';
import { rpc } from '../../lib/rpcPool.js';
import { getRelayerAccount, pingRouterAbi } from '../../lib/router.js';
import { publicClient } from '../../lib/viem.js';
import { lockPhoneMutation } from '../phone/lock.js';
import { applyRouterLog, sendEscrowInvite } from './events.js';
import { markEscrowsClaimable, matchesEscrowRecipient } from './ready.js';
import { checkSolvency } from './solvency.js';
import { claimJobKey, claimRegisteredEscrow, enqueueClaim, selfClaimKey, type ClaimJob } from './service.js';
import { assertRouterOperationEnabled, isRouterIncidentStop } from './incident.js';

const MINUTE = 60_000;

async function afterDeposit(id: string): Promise<void> {
  await claimRegisteredEscrow(id);
  await sendEscrowInvite(id);
}

export async function confirmEscrow(id: string, attempt: number): Promise<void> {
  if (!config.ROUTER_ADDRESS) return;
  const [row] = await db.select().from(escrows).where(eq(escrows.id, id)).limit(1);
  if (!row?.depositTxHash || !['authorized', 'void'].includes(row.status)) return;
  let receipt;
  try { receipt = await publicClient.getTransactionReceipt({ hash: row.depositTxHash as Hex }); }
  catch {
    if (Date.now() < row.authDeadline.getTime() + 35 * MINUTE) {
      const next = attempt + 1;
      await enqueue('escrows', 'confirm', { escrowId: id, attempt: next }, {
        delay: Math.min(MINUTE, Math.round(4000 * 1.6 ** Math.min(next - 1, 20))), jobId: `confirm-${id}-${next}`,
      });
    }
    return;
  }
  if (receipt.transactionHash.toLowerCase() !== row.depositTxHash) return;
  if (receipt.status === 'reverted') {
    await db.update(escrows).set({ status: 'void' }).where(and(eq(escrows.id, id), eq(escrows.status, 'authorized')));
    return;
  }
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const ids = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const deposited: string[] = [];
    for (const log of receipt.logs) {
      const changed = await applyRouterLog(tx, log, new Date(Number(block.timestamp) * 1000));
      if (changed) deposited.push(changed);
    }
    return deposited;
  });
  for (const deposited of ids) await afterDeposit(deposited);
}

export type IndexEscrowsOptions = {
  /** Runs after the indexed logs and cursor commit, before post-commit dispatch. */
  afterPersistedBlock?: (depositedIds: readonly string[]) => Promise<void>;
};

export async function indexEscrows(options: IndexEscrowsOptions = {}): Promise<void> {
  if (!config.ROUTER_ADDRESS) return;
  const address = normAddress(config.ROUTER_ADDRESS);
  const scope = `${viemChain.id}:${address}`;
  const sameScope = await kvGet<string>('router:scope') === scope;
  let from = BigInt(sameScope ? await kvGet<string>('router:lastBlock') ?? String(config.ROUTER_DEPLOY_BLOCK) : config.ROUTER_DEPLOY_BLOCK);
  const latest = await publicClient.getBlockNumber();
  while (from <= latest) {
    const to = from + 9999n < latest ? from + 9999n : latest;
    const logs = await publicClient.getLogs({ address, fromBlock: from, toBlock: to });
    const dates = new Map<bigint, Date>();
    for (const log of logs) {
      if (log.blockNumber !== null && !dates.has(log.blockNumber)) {
        const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
        dates.set(log.blockNumber, new Date(Number(block.timestamp) * 1000));
      }
    }
    const deposited = await db.transaction(async (tx) => {
      await lockPhoneMutation(tx);
      const ids: string[] = [];
      for (const log of logs) {
        if (log.blockNumber === null) continue;
        const id = await applyRouterLog(tx, log, dates.get(log.blockNumber)!);
        if (id) ids.push(id);
      }
      await kvSet('router:lastBlock', (to + 1n).toString(), tx);
      await kvSet('router:scope', scope, tx);
      return ids;
    });
    await options.afterPersistedBlock?.(deposited);
    for (const id of deposited) await afterDeposit(id);
    from = to + 1n;
  }
  // Recover work after a crash between database commit and queue/SMS dispatch.
  const pending = await db.select().from(escrows).where(inArray(escrows.status, ['deposited', 'claiming']));
  for (const row of pending) {
    if (row.deliveryMode === 'automatic' && row.status === 'deposited') await claimRegisteredEscrow(row.id);
    if (row.deliveryMode === 'claim' && row.smsNextAttemptAt && row.smsNextAttemptAt <= new Date() &&
        ['deferred_budget', 'deferred_rate_limit', 'provider_rejected', 'disabled'].includes(row.smsStatus)) {
      await sendEscrowInvite(row.id);
    }
    if (row.status === 'claiming') {
      const job = await kvGet<ClaimJob>(claimJobKey(row.id));
      if (job) await enqueueClaim(job, `-recover-${Math.floor(Date.now() / MINUTE)}`);
    }
  }
}

async function resetClaim(id: string, signature: Hex): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const current = await kvGet<ClaimJob>(claimJobKey(id), tx);
    if (current?.signature !== signature) return;
    const [row] = await tx.update(escrows).set({ status: 'deposited', claimTxHash: null, recipientUserId: null })
      .where(and(eq(escrows.id, id), eq(escrows.status, 'claiming'))).returning();
    if (row) {
      const [recipient] = await tx.select({ id: users.id }).from(users).where(eq(users.phoneHmac, row.recipientPhoneHmac)).limit(1);
      if (recipient) await markEscrowsClaimable(tx, row.recipientPhoneHmac, recipient.id);
    }
    if (row) await tx.delete(kv).where(eq(kv.key, claimJobKey(id)));
  });
}

export async function relayClaim(job: ClaimJob): Promise<void> {
  if (!config.ROUTER_ADDRESS) return;
  const [row] = await db.select().from(escrows).where(eq(escrows.id, job.auth.id)).limit(1);
  if (!row || row.status !== 'claiming') return;
  const current = await kvGet<ClaimJob>(claimJobKey(row.id));
  if (current?.signature !== job.signature) return; // An old retry must not reset or submit a newer claim.
  let hash = row.claimTxHash as Hex | null;
  try {
    if (!hash) {
      const block = await publicClient.getBlock();
      if (block.timestamp > BigInt(job.auth.deadline)) { await resetClaim(row.id, job.signature); return; }
      try { await assertRouterOperationEnabled('relay-broadcasts'); } catch (error) {
        if (isRouterIncidentStop(error)) return;
        throw error;
      }
      const account = getRelayerAccount();
      const balance = await publicClient.getBalance({ address: account.address });
      logger.info({ balanceWei: balance.toString() }, 'escrow relayer balance');
      if (balance < 10000000000000000n) logger.warn({ balanceWei: balance.toString() }, 'escrow relayer balance below 0.01 ETH');
      const wallet = createWalletClient({ account, chain: viemChain,
        transport: custom({ request: ({ method, params }) => rpc(method, params ?? []) }) });
      const auth = { ...job.auth, deadline: BigInt(job.auth.deadline) };
      hash = await db.transaction(async (tx) => {
        // Keep phone mutations serialized through broadcast, closing the gap
        // between queued authorization and relaying it. Once broadcast, that
        // transaction may still finish paying the authorized wallet.
        await lockPhoneMutation(tx);
        const [fresh] = await tx.select().from(escrows).where(eq(escrows.id, row.id)).limit(1).for('update');
        const latest = await kvGet<ClaimJob>(claimJobKey(row.id), tx);
        if (!fresh || fresh.status !== 'claiming' || latest?.signature !== job.signature) return null;
        if (fresh.claimTxHash) return fresh.claimTxHash as Hex;
        const [recipient] = await tx.select().from(users)
          .where(eq(users.address, normAddress(job.auth.recipient))).limit(1);
        const [dispute] = await tx.select({ id: phoneClaims.id }).from(phoneClaims).where(and(
          eq(phoneClaims.phoneHmac, fresh.recipientPhoneHmac), eq(phoneClaims.status, 'pending_review'),
        )).limit(1);
        if (!recipient || fresh.recipientUserId !== recipient.id || !matchesEscrowRecipient(fresh, recipient) || dispute) {
          await tx.update(escrows).set({ status: 'deposited', claimTxHash: null, recipientUserId: null })
            .where(eq(escrows.id, fresh.id));
          if (recipient && !dispute) await markEscrowsClaimable(tx, fresh.recipientPhoneHmac, recipient.id);
          return null;
        }
        const { request } = await publicClient.simulateContract({ address: normAddress(config.ROUTER_ADDRESS), abi: pingRouterAbi,
          functionName: 'claim', args: [auth, job.signature], account });
        // A recipient contract (or token hook) can burn relayer gas on payout. Above the
        // ceiling, stop relaying this escrow and let the recipient submit it themselves.
        const gas = await publicClient.estimateContractGas(request);
        if (gas > BigInt(config.RELAY_CLAIM_MAX_GAS)) {
          await tx.update(escrows).set({ status: 'deposited', claimTxHash: null }).where(eq(escrows.id, fresh.id));
          await tx.delete(kv).where(eq(kv.key, claimJobKey(fresh.id)));
          await kvSet(selfClaimKey(fresh.id), true, tx);
          await notify(recipient.id, 'escrow_incoming', { escrowId: fresh.id }, tx);
          logger.warn({ escrowId: fresh.id, gas: gas.toString() }, 'claim gas above relay ceiling; recipient must self-claim');
          return null;
        }
        const latestBlock = await publicClient.getBlock();
        if (latestBlock.timestamp > BigInt(job.auth.deadline)) {
          await tx.update(escrows).set({ status: 'deposited', claimTxHash: null, recipientUserId: null })
            .where(eq(escrows.id, fresh.id));
          await tx.delete(kv).where(eq(kv.key, claimJobKey(fresh.id)));
          await markEscrowsClaimable(tx, fresh.recipientPhoneHmac, recipient.id);
          return null;
        }
        // This is the last awaited operation before broadcast; an incident stop
        // leaves the durable outbox untouched for later recovery or expiry.
        try { await assertRouterOperationEnabled('relay-broadcasts', tx); } catch (error) {
          if (isRouterIncidentStop(error)) return null;
          throw error;
        }
        const submitted = await wallet.writeContract({ ...request, gas: gas + gas / 5n });
        await tx.update(escrows).set({ claimTxHash: submitted }).where(eq(escrows.id, fresh.id));
        return submitted;
      });
      if (!hash) return;
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status === 'reverted') { await resetClaim(row.id, job.signature); return; }
    // Only indexed router events finalize the database status and notifications.
    await indexEscrows();
    await Promise.all([invalidate(`bal:${row.senderAddress}`), invalidate(`bal:${job.auth.recipient.toLowerCase()}`)]);
  } catch (error) {
    const reverted = error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
    if (reverted) { await resetClaim(row.id, job.signature); return; }
    const block = await publicClient.getBlock();
    if (block.timestamp > BigInt(job.auth.deadline)) {
      // Reconcile first: a receipt timeout can follow a successful mined claim.
      await indexEscrows();
      await resetClaim(row.id, job.signature);
      return;
    }
    // A timeout may follow a broadcast. Keep claiming/hash for receipt recovery.
    throw error;
  }
}

export default async function registerJobs(ctx: WorkerCtx): Promise<void> {
  if (!config.ROUTER_ADDRESS) return;
  await getQueue('escrows').setGlobalConcurrency(1);
  ctx.process('escrows', 'confirm', async (job) => {
    const data = job.data as { escrowId?: unknown; attempt?: unknown };
    if (typeof data.escrowId !== 'string' || typeof data.attempt !== 'number' || !Number.isSafeInteger(data.attempt) || data.attempt < 0) return;
    await confirmEscrow(data.escrowId, data.attempt);
  });
  ctx.process('escrows', 'index', async () => indexEscrows());
  ctx.process('escrows', 'relay', async (job) => relayClaim(job.data as ClaimJob));
  ctx.process('escrows', 'sweep', async () => {
    await db.update(escrows).set({ status: 'void' }).where(and(eq(escrows.status, 'authorized'),
      lt(escrows.authDeadline, new Date(Date.now() - 35 * MINUTE))));
  });
  ctx.process('escrows', 'solvency', checkSolvency);
  await ctx.schedule('escrows', 'index', MINUTE);
  await ctx.schedule('escrows', 'solvency', 5 * MINUTE);
  await ctx.schedule('escrows', 'sweep', 10 * MINUTE);
}
