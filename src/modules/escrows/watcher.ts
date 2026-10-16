import { createHash } from 'node:crypto';
import { decodeEventLog, hashTypedData, zeroAddress, type Address, type Log } from 'viem';
import { pingRouterAbi } from '../../lib/pingRouterAbi.js';
import { RouterWatchJournal, type WatchAlert } from './watchJournal.js';

const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const erc20BalanceAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const;
const claimAuthTypes = { ClaimAuth: [
  { name: 'id', type: 'bytes32' }, { name: 'recipient', type: 'address' },
  { name: 'relayer', type: 'address' }, { name: 'deadline', type: 'uint256' },
] } as const;

export type WatchAuthorization = {
  requestId: string; escrowId: string; kind: string; recipientAddress: string; relayerAddress: string;
  deadline: Date; signedAt: Date; domainName: string; domainVersion: string; domainChainId: bigint;
  domainVerifyingContract: string; typedDataDigest: string;
};
export type WatchEscrow = {
  id: string; tokenAddress: string; amountRaw: string; claimTipWei: string; status: string;
};
export type WatchMetrics = {
  indexerNextBlock: bigint | null;
  signingLastHour: number;
  stuckClaims: number;
  smsBudgetDeferred: number;
  smsProviderUnknown: number;
  openEscrows: WatchEscrow[];
  solvencyScopeExceeded: boolean;
};
export type RouterWatchConfig = {
  chainId: number; routerAddress: Address; startBlock: bigint; confirmations: bigint; chunkBlocks: bigint;
  signingTimeSkewSeconds: number;
  indexerLagBlocks: bigint; signingPerHourLimit: number; stuckClaimMinutes: number;
  smsBudgetDeferredLimit: number; smsProviderUnknownLimit: number; relayerAddress?: Address;
  relayerMinBalanceWei: bigint;
};
export type WatchLog = Pick<Log, 'address' | 'data' | 'topics' | 'blockNumber' | 'blockHash' | 'transactionHash' | 'logIndex'>;
export type WatchBlock = { timestamp: bigint; hash: `0x${string}` };
export type WatchChain = {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<WatchBlock>;
  getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<WatchLog[]>;
  getBalance(args: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
};
export type WatchRepository = {
  getEscrow(id: string): Promise<WatchEscrow | null>;
  getClaimAuthorizations(id: string): Promise<WatchAuthorization[]>;
  getMetrics(since: Date, staleBefore: Date): Promise<WatchMetrics>;
};
export type RouterWatcherDependencies = {
  config: RouterWatchConfig; chain: WatchChain; repository: WatchRepository; journal: RouterWatchJournal;
  deliver?: (alert: WatchAlert) => Promise<void>; now?: () => Date;
};

function jsonScalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return value === null || value === undefined ? null : String(value);
}

function alertId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function addAlert(deps: RouterWatcherDependencies, values: Omit<WatchAlert, 'occurredAt' | 'chainId' | 'router'> & { occurredAt?: string }): void {
  deps.journal.appendAlert({
    ...values,
    occurredAt: values.occurredAt ?? (deps.now ?? (() => new Date()))().toISOString(),
    chainId: deps.config.chainId,
    router: deps.config.routerAddress.toLowerCase(),
  });
}

function currentEventBindings(rows: WatchAuthorization[], eventTime: Date, skewSeconds: number): { relevant: WatchAuthorization[]; skewed: WatchAuthorization[] } {
  const eventSeconds = Math.floor(eventTime.getTime() / 1000);
  const deadlineValid = rows.filter((row) => Math.floor(row.deadline.getTime() / 1000) >= eventSeconds);
  const relevant = deadlineValid.filter((row) => Math.floor(row.signedAt.getTime() / 1000) <= eventSeconds);
  const skewLimit = eventSeconds + skewSeconds;
  return { relevant, skewed: deadlineValid.filter((row) => {
    const signedAt = Math.floor(row.signedAt.getTime() / 1000);
    return signedAt > eventSeconds && signedAt <= skewLimit;
  }) };
}

function digestMatches(row: WatchAuthorization, id: string): boolean {
  try {
    const computed = hashTypedData({
      domain: { name: row.domainName, version: row.domainVersion, chainId: row.domainChainId,
        verifyingContract: row.domainVerifyingContract as Address },
      types: claimAuthTypes,
      primaryType: 'ClaimAuth',
      message: { id: id as `0x${string}`, recipient: row.recipientAddress as Address,
        relayer: row.relayerAddress as Address, deadline: BigInt(Math.floor(row.deadline.getTime() / 1000)) },
    });
    return computed.toLowerCase() === row.typedDataDigest.toLowerCase();
  } catch {
    return false;
  }
}

async function inspectClaim(
  deps: RouterWatcherDependencies,
  id: string,
  recipient: string,
  relayer: string,
  eventTime: Date,
  eventId: string,
): Promise<void> {
  const escrow = await deps.repository.getEscrow(id);
  if (!escrow) {
    addAlert(deps, { id: alertId(`${eventId}:unknown-escrow`), code: 'unknown_escrow_id', severity: 'critical',
      details: { escrowId: id, event: 'Claimed' }, occurredAt: eventTime.toISOString() });
  }
  const history = await deps.repository.getClaimAuthorizations(id);
  const bindings = currentEventBindings(history, eventTime, deps.config.signingTimeSkewSeconds);
  const relevant = bindings.relevant.length ? bindings.relevant : bindings.skewed;
  if (relevant.length === 0) {
    addAlert(deps, { id: alertId(`${eventId}:unauthorized`), code: 'claim_unauthorized', severity: 'critical',
      details: { escrowId: id, event: 'Claimed', reason: history.length ? 'no-signature-valid-at-event-block-time' : 'no-signing-record' },
      occurredAt: eventTime.toISOString() });
    return;
  }
  if (bindings.relevant.length === 0) {
    addAlert(deps, { id: alertId(`${eventId}:signing-time-skew`), code: 'claim_signing_time_skew', severity: 'critical',
      details: { escrowId: id, requestIds: bindings.skewed.map((row) => row.requestId),
        allowedSeconds: deps.config.signingTimeSkewSeconds,
        reason: 'signing record follows event block time; review chain and host clock skew' }, occurredAt: eventTime.toISOString() });
  }
  const expectedRecipients = [...new Set(relevant.map((row) => row.recipientAddress.toLowerCase()))];
  const expectedRelayers = [...new Set(relevant.map((row) => row.relayerAddress.toLowerCase()))];
  const gotRecipient = recipient.toLowerCase();
  const gotRelayer = relayer.toLowerCase();
  if (!expectedRecipients.includes(gotRecipient)) {
    addAlert(deps, { id: alertId(`${eventId}:recipient-mismatch`), code: 'claim_recipient_mismatch', severity: 'critical',
      details: { escrowId: id, actualRecipient: gotRecipient, expectedRecipients }, occurredAt: eventTime.toISOString() });
  }
  if (!expectedRelayers.includes(gotRelayer)) {
    addAlert(deps, { id: alertId(`${eventId}:relayer-mismatch`), code: 'claim_relayer_mismatch', severity: 'critical',
      details: { escrowId: id, actualRelayer: gotRelayer, expectedRelayers }, occurredAt: eventTime.toISOString() });
  }
  const matchingPairs = relevant.filter((row) => row.recipientAddress.toLowerCase() === gotRecipient &&
    row.relayerAddress.toLowerCase() === gotRelayer);
  const validDomain = matchingPairs.filter((row) => row.domainName === 'PingRouter' && row.domainVersion === '1' &&
    row.domainChainId === BigInt(deps.config.chainId) && row.domainVerifyingContract.toLowerCase() === deps.config.routerAddress.toLowerCase());
  if (matchingPairs.length && !validDomain.length) {
    addAlert(deps, { id: alertId(`${eventId}:domain-mismatch`), code: 'claim_authorization_domain_mismatch', severity: 'critical',
      details: { escrowId: id, requestIds: matchingPairs.map((row) => row.requestId) }, occurredAt: eventTime.toISOString() });
  } else if (validDomain.length && !validDomain.some((row) => digestMatches(row, id))) {
    addAlert(deps, { id: alertId(`${eventId}:digest-mismatch`), code: 'claim_authorization_digest_mismatch', severity: 'critical',
      details: { escrowId: id, requestIds: validDomain.map((row) => row.requestId) }, occurredAt: eventTime.toISOString() });
  } else if (expectedRecipients.includes(gotRecipient) && expectedRelayers.includes(gotRelayer) && matchingPairs.length === 0) {
    addAlert(deps, { id: alertId(`${eventId}:binding-mismatch`), code: 'claim_binding_mismatch', severity: 'critical',
      details: { escrowId: id, actualRecipient: gotRecipient, actualRelayer: gotRelayer }, occurredAt: eventTime.toISOString() });
  }
}

async function inspectEvent(deps: RouterWatcherDependencies, log: WatchLog, timestamp: bigint): Promise<void> {
  const eventTime = new Date(Number(timestamp) * 1000);
  const blockNumber = log.blockNumber ?? 0n;
  const eventPosition = `${log.blockHash ?? blockNumber}:${log.logIndex ?? 0}`;
  const eventRecordId = `event:${deps.config.chainId}:${eventPosition}`;
  let decoded;
  try {
    decoded = decodeEventLog({ abi: pingRouterAbi, data: log.data, topics: log.topics, strict: false });
  } catch {
    deps.journal.appendEvent({ id: eventRecordId, chainId: deps.config.chainId, router: deps.config.routerAddress.toLowerCase(),
      blockNumber: blockNumber.toString(), blockHash: log.blockHash ?? null, transactionHash: log.transactionHash ?? null,
      logIndex: log.logIndex ?? null, eventName: null, args: null, observedAt: (deps.now ?? (() => new Date()))().toISOString() });
    addAlert(deps, { id: alertId(`${eventRecordId}:decode`), code: 'unrecognized_router_log', severity: 'warning',
      details: { blockNumber: blockNumber.toString(), transactionHash: log.transactionHash ?? null },
      occurredAt: eventTime.toISOString() });
    return;
  }
  const args = Object.fromEntries(Object.entries(decoded.args ?? {}).map(([key, value]) => [key, jsonScalar(value)]));
  deps.journal.appendEvent({ id: eventRecordId, chainId: deps.config.chainId, router: deps.config.routerAddress.toLowerCase(),
    blockNumber: blockNumber.toString(), blockHash: log.blockHash ?? null, transactionHash: log.transactionHash ?? null,
    logIndex: log.logIndex ?? null, eventName: decoded.eventName, args,
    observedAt: (deps.now ?? (() => new Date()))().toISOString() });

  if (decoded.eventName === 'Claimed') {
    const claim = decoded.args as { id: string; recipient: string; relayer: string };
    await inspectClaim(deps, claim.id, claim.recipient, claim.relayer, eventTime, eventRecordId);
    return;
  }
  if (decoded.eventName === 'Escrowed' || decoded.eventName === 'Refunded') {
    const id = (decoded.args as { id: string }).id;
    if (!await deps.repository.getEscrow(id)) {
      addAlert(deps, { id: alertId(`${eventRecordId}:unknown-escrow`), code: 'unknown_escrow_id', severity: 'critical',
        details: { escrowId: id, event: decoded.eventName }, occurredAt: eventTime.toISOString() });
    }
  }
}

async function inspectSolvency(
  deps: RouterWatcherDependencies,
  metrics: WatchMetrics,
  head: bigint,
  bucket: string,
): Promise<void> {
  if (metrics.solvencyScopeExceeded) {
    addAlert(deps, { id: alertId(`metric:solvency-scope:${bucket}`), code: 'solvency_scope_exceeded', severity: 'warning',
      details: { bucket }, });
    return;
  }
  const [feesAccrued, totalOwed] = await Promise.all([
    deps.chain.readContract({ address: deps.config.routerAddress, abi: pingRouterAbi, functionName: 'feesAccrued', blockNumber: head }),
    deps.chain.readContract({ address: deps.config.routerAddress, abi: pingRouterAbi, functionName: 'totalOwed', blockNumber: head }),
  ]);
  const required = new Map<string, bigint>([[NATIVE_TOKEN, BigInt(String(feesAccrued)) + BigInt(String(totalOwed))]]);
  for (const row of metrics.openEscrows) {
    const state = await deps.chain.readContract({ address: deps.config.routerAddress, abi: pingRouterAbi,
      functionName: 'escrows', args: [row.id], blockNumber: head }) as readonly [string, bigint, string, bigint, bigint];
    if (state[0] === zeroAddress) continue;
    const token = state[2].toLowerCase();
    required.set(NATIVE_TOKEN, required.get(NATIVE_TOKEN)! + state[4]);
    if (token !== NATIVE_TOKEN) required.set(token, (required.get(token) ?? 0n) + state[3]);
    else required.set(NATIVE_TOKEN, required.get(NATIVE_TOKEN)! + state[3]);
  }
  for (const [token, amount] of required) {
    const balance = token === NATIVE_TOKEN
      ? await deps.chain.getBalance({ address: deps.config.routerAddress, blockNumber: head })
      : BigInt(String(await deps.chain.readContract({ address: token as Address, abi: erc20BalanceAbi,
        functionName: 'balanceOf', args: [deps.config.routerAddress], blockNumber: head })));
    if (balance < amount) {
      addAlert(deps, { id: alertId(`metric:solvency:${token}:${bucket}`), code: 'router_solvency_shortfall', severity: 'critical',
        details: { token, required: amount.toString(), balance: balance.toString(), blockNumber: head.toString() } });
    }
  }
}

async function inspectMetrics(deps: RouterWatcherDependencies, head: bigint): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const bucket = now.toISOString().slice(0, 13);
  const metrics = await deps.repository.getMetrics(new Date(now.getTime() - 60 * 60_000),
    new Date(now.getTime() - deps.config.stuckClaimMinutes * 60_000));
  const lag = metrics.indexerNextBlock === null ? head + 1n : head + 1n - metrics.indexerNextBlock;
  if (lag > deps.config.indexerLagBlocks) {
    addAlert(deps, { id: alertId(`metric:indexer-lag:${bucket}`), code: 'router_indexer_lag', severity: 'warning',
      details: { lagBlocks: lag.toString(), thresholdBlocks: deps.config.indexerLagBlocks.toString(), nextBlock: metrics.indexerNextBlock?.toString() ?? null } });
  }
  if (metrics.signingLastHour > deps.config.signingPerHourLimit) {
    addAlert(deps, { id: alertId(`metric:signing-volume:${bucket}`), code: 'router_signing_volume_high', severity: 'warning',
      details: { count: metrics.signingLastHour, threshold: deps.config.signingPerHourLimit } });
  }
  if (metrics.stuckClaims > 0) {
    addAlert(deps, { id: alertId(`metric:stuck-claims:${bucket}`), code: 'router_claims_stuck', severity: 'warning',
      details: { count: metrics.stuckClaims, staleMinutes: deps.config.stuckClaimMinutes } });
  }
  if (metrics.smsBudgetDeferred >= deps.config.smsBudgetDeferredLimit && deps.config.smsBudgetDeferredLimit > 0) {
    addAlert(deps, { id: alertId(`metric:sms-budget:${bucket}`), code: 'sms_budget_exhaustion', severity: 'warning',
      details: { deferredInvites: metrics.smsBudgetDeferred, threshold: deps.config.smsBudgetDeferredLimit } });
  }
  if (metrics.smsProviderUnknown >= deps.config.smsProviderUnknownLimit && deps.config.smsProviderUnknownLimit > 0) {
    addAlert(deps, { id: alertId(`metric:sms-unknown:${bucket}`), code: 'sms_provider_unknown', severity: 'warning',
      details: { unknownOutcomes: metrics.smsProviderUnknown, threshold: deps.config.smsProviderUnknownLimit } });
  }
  await inspectSolvency(deps, metrics, head, bucket);
  if (deps.config.relayerAddress) {
    const balance = await deps.chain.getBalance({ address: deps.config.relayerAddress, blockNumber: head });
    if (balance < deps.config.relayerMinBalanceWei) {
      addAlert(deps, { id: alertId(`metric:relayer-balance:${bucket}`), code: 'router_relayer_balance_low', severity: 'warning',
        details: { address: deps.config.relayerAddress.toLowerCase(), balanceWei: balance.toString(),
          thresholdWei: deps.config.relayerMinBalanceWei.toString() } });
    }
  }
}

async function deliverPending(deps: RouterWatcherDependencies): Promise<void> {
  if (!deps.deliver) return;
  const now = (deps.now ?? (() => new Date()))();
  for (const alert of deps.journal.state(now).pendingAlerts) {
    deps.journal.beginDelivery(alert.id, now);
    try {
      await deps.deliver(alert);
      deps.journal.markDelivered(alert.id);
    } catch {
      // Delivery is at-least-once; the durable attempt row backs off retries.
      // A failed channel never blocks chain scanning or the durable cursor.
    }
  }
}

export class RouterWatcherReorgError extends Error {
  constructor() {
    super('Router watcher checkpoint block hash changed; operator review is required before scanning resumes.');
    this.name = 'RouterWatcherReorgError';
  }
}

/** Process confirmed router logs, durably journal evidence, then advance and retry delivery. */
export async function scanRouterOnce(deps: RouterWatcherDependencies): Promise<void> {
  try {
    const actualChainId = await deps.chain.getChainId();
    if (actualChainId !== deps.config.chainId) throw new Error(`Watcher RPC chain mismatch: expected ${deps.config.chainId}, received ${actualChainId}.`);
    const state = deps.journal.state();
    if (state.checkpoint) {
      const current = await deps.chain.getBlock({ blockNumber: state.checkpoint.blockNumber });
      if (current.hash.toLowerCase() !== state.checkpoint.hash) {
        addAlert(deps, { id: alertId(`reorg:${state.checkpoint.blockNumber}:${state.checkpoint.hash}:${current.hash}`),
          code: 'router_watcher_reorg', severity: 'critical', details: { blockNumber: state.checkpoint.blockNumber.toString(),
            storedHash: state.checkpoint.hash, currentHash: current.hash } });
        await deliverPending(deps);
        throw new RouterWatcherReorgError();
      }
    }
    const latest = await deps.chain.getBlockNumber();
    const confirmedHead = latest > deps.config.confirmations ? latest - deps.config.confirmations : 0n;
    let nextBlock = state.nextBlock ?? deps.config.startBlock;
    while (nextBlock <= confirmedHead) {
      const endBlock = nextBlock + deps.config.chunkBlocks - 1n < confirmedHead ? nextBlock + deps.config.chunkBlocks - 1n : confirmedHead;
      try {
        const logs = await deps.chain.getLogs({ address: deps.config.routerAddress, fromBlock: nextBlock, toBlock: endBlock });
        const ordered = [...logs].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) ||
          Number((a.logIndex ?? 0) - (b.logIndex ?? 0)));
        const blockCache = new Map<bigint, WatchBlock>();
        const getBlock = async (blockNumber: bigint): Promise<WatchBlock> => {
          let block = blockCache.get(blockNumber);
          if (!block) {
            block = await deps.chain.getBlock({ blockNumber });
            blockCache.set(blockNumber, block);
          }
          return block;
        };
        for (const log of ordered) {
          const blockNumber = log.blockNumber ?? endBlock;
          const block = await getBlock(blockNumber);
          if (log.blockHash && log.blockHash.toLowerCase() !== block.hash.toLowerCase()) {
            addAlert(deps, { id: alertId(`reorg:log:${blockNumber}:${log.blockHash}:${block.hash}`),
              code: 'router_watcher_reorg', severity: 'critical', details: { blockNumber: blockNumber.toString(),
                logHash: log.blockHash, currentHash: block.hash } });
            throw new RouterWatcherReorgError();
          }
          await inspectEvent(deps, log, block.timestamp);
        }
        const checkpoint = await getBlock(endBlock);
        // Event and anomaly lines are fsynced before the cursor; only confirmed blocks advance.
        deps.journal.advance(endBlock + 1n, endBlock, checkpoint.hash);
        nextBlock = endBlock + 1n;
      } finally {
        // Catch-up runs can be long. Flush durable alerts after each cursor chunk.
        await deliverPending(deps);
      }
    }
    await deliverPending(deps);
    if (confirmedHead >= deps.config.startBlock) {
      try {
        await inspectMetrics(deps, confirmedHead);
      } finally {
        // Metrics may fail independently; they must not starve chain alerts.
        await deliverPending(deps);
      }
    }
  } finally {
    await deliverPending(deps);
  }
}

export async function postAlert(url: URL, token: string | undefined, alert: WatchAlert): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': alert.id,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(alert),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Operator delivery returned HTTP ${response.status}.`);
  } finally {
    clearTimeout(timeout);
  }
}
