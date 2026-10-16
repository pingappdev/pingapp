import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, hashTypedData, parseAbiItem, parseAbiParameters, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RouterWatcherReorgError, scanRouterOnce, type RouterWatchConfig, type WatchAuthorization,
  postAlert, type WatchChain, type WatchEscrow, type WatchLog, type WatchMetrics, type WatchRepository,
} from '../src/modules/escrows/watcher.js';
import { RouterWatchJournal, writeAllSync } from '../src/modules/escrows/watchJournal.js';

const ROUTER = '0x0000000000000000000000000000000000000003' as Address;
const RECIPIENT = '0x0000000000000000000000000000000000000004' as Address;
const RELAYER = '0x0000000000000000000000000000000000000005' as Address;
const OTHER = '0x0000000000000000000000000000000000000006' as Address;
const TOKEN = '0x0000000000000000000000000000000000000007' as Address;
const CLAIMED_EVENT = parseAbiItem('event Claimed(bytes32 indexed id, address indexed recipient, address indexed relayer, address token, uint256 amount, uint256 claimTip)');
const CLAIM_DATA = parseAbiParameters('address token, uint256 amount, uint256 claimTip');
const DOMAIN = { name: 'PingRouter', version: '1', chainId: 4663, verifyingContract: ROUTER } as const;
const eventTimestamp = 1_800_000_000n;
const eventDate = new Date(Number(eventTimestamp) * 1000);

const tempDirs: string[] = [];
const openJournals: RouterWatchJournal[] = [];

function makeJournal(scope = { chainId: 4663, router: ROUTER, startBlock: 40n }) {
  const dir = mkdtempSync(join(tmpdir(), 'pingapp-audit-monitor-'));
  tempDirs.push(dir);
  const journal = new RouterWatchJournal(join(dir, 'watch.jsonl'), scope);
  openJournals.push(journal);
  return journal;
}

function fixtureId(index: number): `0x${string}` {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

function blockHash(blockNumber: bigint, salt = 0): `0x${string}` {
  return `0x${(blockNumber + BigInt(salt)).toString(16).padStart(64, '0')}`;
}

function claimedLog(id: string, recipient: Address, relayer: Address, blockNumber = 98n, logIndex = 0): WatchLog {
  const topics = encodeEventTopics({ abi: [CLAIMED_EVENT], eventName: 'Claimed', args: {
    id: id as `0x${string}`, recipient, relayer,
  } });
  return {
    address: ROUTER, topics, data: encodeAbiParameters(CLAIM_DATA, [TOKEN, 1_000_000n, 0n]),
    blockNumber, blockHash: blockHash(blockNumber), transactionHash: blockHash(blockNumber + 100n), logIndex,
  } as WatchLog;
}

function authorization(id: string, values: Partial<WatchAuthorization> = {}): WatchAuthorization {
  const auth = {
    requestId: `request-${id.slice(-4)}`, escrowId: id, kind: 'relayed', recipientAddress: RECIPIENT,
    relayerAddress: RELAYER, deadline: new Date((Number(eventTimestamp) + 120) * 1000),
    signedAt: new Date((Number(eventTimestamp) - 30) * 1000), domainName: DOMAIN.name,
    domainVersion: DOMAIN.version, domainChainId: BigInt(DOMAIN.chainId),
    domainVerifyingContract: DOMAIN.verifyingContract,
    typedDataDigest: '', ...values,
  };
  auth.typedDataDigest = hashTypedData({ domain: {
    name: auth.domainName, version: auth.domainVersion, chainId: auth.domainChainId,
    verifyingContract: auth.domainVerifyingContract as Address,
  }, types: { ClaimAuth: [
    { name: 'id', type: 'bytes32' }, { name: 'recipient', type: 'address' },
    { name: 'relayer', type: 'address' }, { name: 'deadline', type: 'uint256' },
  ] }, primaryType: 'ClaimAuth', message: { id: id as `0x${string}`,
    recipient: auth.recipientAddress as Address, relayer: auth.relayerAddress as Address,
    deadline: BigInt(Math.floor(auth.deadline.getTime() / 1000)) },
  });
  return auth;
}

function createFixture(options: {
  logs?: WatchLog[]; auths?: Map<string, WatchAuthorization[]>; knownIds?: Set<string>;
  now?: () => Date; hashSalt?: number; failMetrics?: boolean;
} = {}) {
  const config: RouterWatchConfig = {
    chainId: 4663, routerAddress: ROUTER, startBlock: 40n, confirmations: 2n, chunkBlocks: 100n,
    signingTimeSkewSeconds: 60, indexerLagBlocks: 100n, signingPerHourLimit: 100,
    stuckClaimMinutes: 10, smsBudgetDeferredLimit: 5, smsProviderUnknownLimit: 1,
    relayerMinBalanceWei: 0n,
  };
  const getLogs = vi.fn(async () => options.logs ?? []);
  const chain: WatchChain = {
    getChainId: async () => 4663,
    getBlockNumber: async () => 100n,
    getBlock: async ({ blockNumber }) => ({ timestamp: eventTimestamp, hash: blockHash(blockNumber, options.hashSalt ?? 0) }),
    getLogs,
    getBalance: async () => 1_000_000_000_000_000_000n,
    readContract: async () => {
      if (options.failMetrics) throw new Error('synthetic chain read failure');
      return 0n;
    },
  };
  const escrow: WatchEscrow = { id: fixtureId(1), tokenAddress: TOKEN, amountRaw: '1000000', claimTipWei: '0', status: 'claimed' };
  const metrics: WatchMetrics = { indexerNextBlock: 99n, signingLastHour: 0, stuckClaims: 0,
    smsBudgetDeferred: 0, smsProviderUnknown: 0, openEscrows: [], solvencyScopeExceeded: false };
  const repository: WatchRepository = {
    getEscrow: async (id) => options.knownIds?.has(id) ? { ...escrow, id } : null,
    getClaimAuthorizations: async (id) => options.auths?.get(id) ?? [],
    getMetrics: async () => metrics,
  };
  return { config, chain, repository, getLogs, now: options.now ?? (() => new Date('2026-10-16T12:00:00Z')) };
}

afterEach(() => {
  for (const journal of openJournals.splice(0)) journal.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('independent router watcher', () => {
  it('writes the full journal buffer across short writes and rejects a stalled write', () => {
    const chunks: Buffer[] = [];
    const shortWriter = ((
      _fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
    ) => {
      const count = Math.min(3, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
      return count;
    }) as typeof writeSync;
    writeAllSync(1, '{"durable":true}\n', shortWriter);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"durable":true}\n');

    const stalledWriter = (() => 0) as typeof writeSync;
    expect(() => writeAllSync(1, 'incomplete', stalledWriter)).toThrow(/incomplete/);
  });

  it('matches relayed and self-claim bindings at the event block time after wall-clock expiry', async () => {
    const relayedId = fixtureId(1);
    const selfId = fixtureId(2);
    const relayed = authorization(relayedId);
    const self = authorization(selfId, { kind: 'self', relayerAddress: RECIPIENT });
    const f = createFixture({
      logs: [claimedLog(relayedId, RECIPIENT, RELAYER), claimedLog(selfId, RECIPIENT, RECIPIENT, 98n, 1)],
      knownIds: new Set([relayedId, selfId]), auths: new Map([[relayedId, [relayed]], [selfId, [self]]]),
      now: () => new Date((Number(eventTimestamp) + 60 * 60) * 1000),
    });
    const journal = makeJournal();

    await scanRouterOnce({ ...f, journal });

    expect(journal.state().nextBlock).toBe(99n);
    expect(journal.state().pendingAlerts.filter((alert) => alert.code.startsWith('claim_'))).toEqual([]);
    expect(journal.state().unacknowledgedAlerts).toBe(0);
    const journalText = readFileSync(journal.path, 'utf8');
    expect(journalText).not.toMatch(/recipientPhoneHmac|phoneLinkedAt|signature|privateKey/i);
    expect(journalText).not.toContain('a'.repeat(64));
  });

  it('alerts on unknown IDs, missing authorization, recipient/relayer mismatch, and expired-at-event signatures', async () => {
    const unknownId = fixtureId(3);
    const mismatchId = fixtureId(4);
    const expiredId = fixtureId(5);
    const mismatch = authorization(mismatchId);
    const expired = authorization(expiredId, { deadline: new Date((Number(eventTimestamp) - 1) * 1000) });
    const f = createFixture({
      logs: [claimedLog(unknownId, RECIPIENT, RELAYER), claimedLog(mismatchId, OTHER, OTHER, 98n, 1),
        claimedLog(expiredId, RECIPIENT, RELAYER, 98n, 2)],
      knownIds: new Set([mismatchId, expiredId]),
      auths: new Map([[mismatchId, [mismatch]], [expiredId, [expired]]]),
    });
    const journal = makeJournal();

    await scanRouterOnce({ ...f, journal });

    const codes = journal.state().pendingAlerts.map((alert) => alert.code);
    expect(codes).toContain('unknown_escrow_id');
    expect(codes).toContain('claim_unauthorized');
    expect(codes).toContain('claim_recipient_mismatch');
    expect(codes).toContain('claim_relayer_mismatch');
    expect(codes).not.toContain('claim_signing_time_skew');
  });

  it('marks a bounded host/chain signing-time skew for review without weakening recipient/domain/digest checks', async () => {
    const id = fixtureId(6);
    const skewed = authorization(id, { signedAt: new Date((Number(eventTimestamp) + 15) * 1000) });
    const f = createFixture({ logs: [claimedLog(id, RECIPIENT, RELAYER)], knownIds: new Set([id]), auths: new Map([[id, [skewed]]]) });
    const journal = makeJournal();

    await scanRouterOnce({ ...f, journal });

    const alert = journal.state().pendingAlerts.find((entry) => entry.code === 'claim_signing_time_skew');
    expect(alert?.severity).toBe('critical');
    expect(alert?.details.requestIds).toEqual([skewed.requestId]);
    expect(journal.state().pendingAlerts.some((entry) => entry.code === 'claim_unauthorized')).toBe(false);
  });

  it('binds the durable journal to chain/router/start scope and locks out concurrent writers', () => {
    const first = makeJournal();
    expect(() => new RouterWatchJournal(first.path, { chainId: 4663, router: ROUTER, startBlock: 40n })).toThrow(/already locked/);
    first.close();
    openJournals.splice(openJournals.indexOf(first), 1);
    expect(() => new RouterWatchJournal(first.path, { chainId: 1, router: ROUTER, startBlock: 40n })).toThrow(/scope differs/);
    const reopened = new RouterWatchJournal(first.path, { chainId: 4663, router: ROUTER, startBlock: 40n });
    openJournals.push(reopened);
  });

  it('loads the durable cursor, checkpoint hash and unacknowledged alert in a fresh process', () => {
    const journal = makeJournal();
    const alert = { id: 'restart-probe-alert', code: 'claim_unauthorized', severity: 'critical' as const,
      occurredAt: eventDate.toISOString(), chainId: 4663, router: ROUTER,
      details: { escrowId: fixtureId(10) } };
    journal.appendEvent({ id: 'restart-probe-event', chainId: 4663, router: ROUTER.toLowerCase(),
      blockNumber: '98', blockHash: blockHash(98n), transactionHash: blockHash(198n), logIndex: 1,
      eventName: 'Claimed', args: { id: fixtureId(10), recipient: RECIPIENT, relayer: RELAYER }, observedAt: eventDate.toISOString() });
    journal.appendAlert(alert);
    journal.advance(99n, 98n, blockHash(98n));
    const journalPath = journal.path;
    journal.close();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const output = execFileSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'test/helpers/router-watch-restart-probe.ts'), journalPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(output)).toEqual({ nextBlock: '99', checkpoint: { blockNumber: '98', hash: blockHash(98n) },
      pendingAlertIds: [alert.id], unacknowledgedAlerts: 1 });
  });

  it('resumes from a durable cursor, retries durable alerts, and fails loudly if a checkpoint reorgs', async () => {
    const id = fixtureId(7);
    const f = createFixture({ logs: [claimedLog(id, RECIPIENT, RELAYER)], now: () => new Date('2026-10-16T12:00:00Z') });
    const journal = makeJournal();
    const delivery = vi.fn(async () => { throw new Error('synthetic local receiver unavailable'); });
    await scanRouterOnce({ ...f, journal, deliver: delivery });
    expect(journal.state().nextBlock).toBe(99n);
    expect(journal.state().unacknowledgedAlerts).toBeGreaterThan(0);
    const attempts = f.getLogs.mock.calls.length;
    journal.close();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const resumed = new RouterWatchJournal(journal.path, { chainId: 4663, router: ROUTER, startBlock: 40n });
    openJournals.push(resumed);
    const resumedFixture = createFixture({ logs: [], now: () => new Date('2026-10-16T12:00:16Z') });
    const delivered = vi.fn(async () => undefined);
    await scanRouterOnce({ ...resumedFixture, journal: resumed, deliver: delivered });
    expect(resumedFixture.getLogs).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalled();
    expect(resumed.state().unacknowledgedAlerts).toBe(0);
    expect(attempts).toBeGreaterThan(0);

    resumed.close();
    openJournals.splice(openJournals.indexOf(resumed), 1);
    const reorged = new RouterWatchJournal(journal.path, { chainId: 4663, router: ROUTER, startBlock: 40n });
    openJournals.push(reorged);
    const badChain = createFixture({ hashSalt: 1 });
    const receiver = vi.fn(async () => undefined);
    await expect(scanRouterOnce({ ...badChain, journal: reorged, deliver: receiver })).rejects.toBeInstanceOf(RouterWatcherReorgError);
    expect(receiver).toHaveBeenCalledWith(expect.objectContaining({ code: 'router_watcher_reorg' }));
    expect(reorged.state().pendingAlerts.some((alert) => alert.code === 'router_watcher_reorg')).toBe(false);
  });

  it('delivers per chunk and retries alerts even when metric reads fail', async () => {
    const id = fixtureId(8);
    const f = createFixture({ logs: [claimedLog(id, RECIPIENT, RELAYER)], failMetrics: true });
    const journal = makeJournal();
    const delivery = vi.fn(async () => { throw new Error('receiver offline'); });

    await expect(scanRouterOnce({ ...f, journal, deliver: delivery })).rejects.toThrow('synthetic chain read failure');
    expect(delivery).toHaveBeenCalled();
    expect(journal.state().nextBlock).toBe(99n);
    expect(journal.state().unacknowledgedAlerts).toBeGreaterThan(0);
  });

  it('sends one sanitized alert to a synthetic loopback receiver with an idempotency key', async () => {
    const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        received.push({ headers: request.headers, body });
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Synthetic receiver failed to bind.');
      const alert = { id: 'synthetic-alert-id', code: 'claim_recipient_mismatch', severity: 'critical' as const,
        occurredAt: eventDate.toISOString(), chainId: 4663, router: ROUTER,
        details: { escrowId: fixtureId(9), actualRecipient: OTHER } };
      await postAlert(new URL(`http://127.0.0.1:${address.port}/alerts`), 'synthetic-token', alert);
      expect(received).toHaveLength(1);
      expect(received[0].headers['idempotency-key']).toBe(alert.id);
      expect(received[0].headers.authorization).toBe('Bearer synthetic-token');
      const body = JSON.parse(received[0].body);
      expect(body).toMatchObject({ id: alert.id, code: alert.code, chainId: 4663 });
      expect(received[0].body).not.toMatch(/phoneHmac|phoneLinkedAt|signature|privateKey/i);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
