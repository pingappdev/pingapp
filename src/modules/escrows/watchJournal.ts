import { closeSync, constants, existsSync, fchmodSync, fsyncSync, ftruncateSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type WatchAlert = {
  id: string;
  code: string;
  severity: 'warning' | 'critical';
  occurredAt: string;
  chainId: number;
  router: string;
  details: Record<string, string | number | boolean | null | string[]>;
};

type EventRecord = {
  type: 'event'; id: string; chainId: number; router: string; blockNumber: string; blockHash: string | null;
  transactionHash: string | null; logIndex: number | null; eventName: string | null;
  args: Record<string, string | number | boolean | null> | null; observedAt: string;
};
type AlertRecord = { type: 'alert'; alert: WatchAlert };
type ScopeRecord = { type: 'scope'; id: 'scope'; chainId: number; router: string; startBlock: string };
type CursorRecord = { type: 'cursor'; id: string; nextBlock: string; checkpointBlock: string; checkpointHash: string; updatedAt: string };
type DeliveryRecord = { type: 'delivery'; id: string; alertId: string; deliveredAt: string };
type DeliveryAttemptRecord = { type: 'delivery_attempt'; id: string; alertId: string; attempt: number; nextAttemptAt: string };
type JournalRecord = ScopeRecord | EventRecord | AlertRecord | CursorRecord | DeliveryRecord | DeliveryAttemptRecord;

export type WatchJournalState = { nextBlock?: bigint; checkpoint?: { blockNumber: bigint; hash: string };
  pendingAlerts: WatchAlert[]; unacknowledgedAlerts: number };
export type WatchJournalScope = { chainId: number; router: string; startBlock: bigint };

export function writeAllSync(fd: number, value: string, write: typeof writeSync = writeSync): void {
  const buffer = Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(written) || written <= 0 || written > buffer.length - offset) {
      throw new Error('Router watcher journal write was incomplete.');
    }
    offset += written;
  }
}

function assertSafeJournalPath(filePath: string): string {
  if (!isAbsolute(filePath)) throw new Error('ROUTER_WATCH_JOURNAL_PATH must be absolute.');
  const resolved = resolve(filePath);
  const cwdRelative = relative(resolve(process.cwd()), resolved);
  if (cwdRelative === '' || (!cwdRelative.startsWith(`..${sep}`) && cwdRelative !== '..' && !isAbsolute(cwdRelative))) {
    throw new Error('Router watcher journal must be outside the application working directory.');
  }
  return resolved;
}

/** Fsync-backed append-only output; cursor advances only after event and alert rows are durable. */
export class RouterWatchJournal {
  readonly path: string;
  private fd: number | undefined;
  private readonly seen = new Set<string>();
  private readonly alerts = new Map<string, WatchAlert>();
  private readonly delivered = new Set<string>();
  private readonly deliveryAttempts = new Map<string, { count: number; nextAttemptAt: number }>();
  private nextBlock: bigint | undefined;
  private checkpoint: { blockNumber: bigint; hash: string } | undefined;
  private readonly lockPath: string;
  private scope?: ScopeRecord;
  private failed = false;

  constructor(filePath: string, scope: WatchJournalScope) {
    this.path = assertSafeJournalPath(filePath);
    this.lockPath = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let lockFd: number | undefined;
    try {
      lockFd = openSync(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch {
      throw new Error('Router watcher journal is already locked; confirm no watcher is running before removing a stale lock.');
    }
    try {
      writeAllSync(lockFd, `${JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() })}\n`);
      fsyncSync(lockFd);
      closeSync(lockFd);
      lockFd = undefined;
      if (existsSync(this.path)) {
        const readFd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data: Buffer;
        try { data = readFileSync(readFd); } finally { closeSync(readFd); }
        const lastNewline = data.lastIndexOf(0x0a);
        const complete = lastNewline < 0 ? Buffer.alloc(0) : data.subarray(0, lastNewline + 1);
        if (complete.length !== data.length) {
          const repairFd = openSync(this.path, constants.O_RDWR | constants.O_NOFOLLOW);
          try { ftruncateSync(repairFd, complete.length); fsyncSync(repairFd); } finally { closeSync(repairFd); }
        }
        for (const line of complete.toString('utf8').split('\n').filter(Boolean)) this.loadRecord(JSON.parse(line) as JournalRecord);
        const priorScope = this.seen.has('scope');
        if (complete.length > 0 && !priorScope) throw new Error('Router watcher journal has no scope record; refusing to reuse it.');
      }
      this.fd = openSync(this.path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      fchmodSync(this.fd, 0o600);
      const dirFd = openSync(dirname(this.path), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      const scopeLine = this.scopeRecord(scope);
      const existingScope = this.scope;
      if (existingScope && (existingScope.chainId !== scopeLine.chainId || existingScope.router !== scopeLine.router ||
          existingScope.startBlock !== scopeLine.startBlock)) {
        throw new Error('Router watcher journal scope differs from configured chain, router, or start block.');
      }
      if (!existingScope) this.append(scopeLine, 'scope');
    } catch (error) {
      if (this.fd !== undefined) {
        closeSync(this.fd);
        this.fd = undefined;
      }
      unlinkSync(this.lockPath);
      throw error;
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
    }
  }

  private scopeRecord(scope: WatchJournalScope): ScopeRecord {
    if (!Number.isSafeInteger(scope.chainId) || scope.chainId <= 0 || scope.startBlock < 0n || !/^0x[0-9a-f]{40}$/i.test(scope.router)) {
      throw new Error('Router watcher journal scope is invalid.');
    }
    return { type: 'scope', id: 'scope', chainId: scope.chainId, router: scope.router.toLowerCase(), startBlock: scope.startBlock.toString() };
  }

  private loadRecord(record: JournalRecord): void {
    if (!record || typeof record !== 'object') throw new Error('Router watcher journal contains an invalid record.');
    if (record.type === 'scope') {
      if (this.scope || record.id !== 'scope' || !Number.isSafeInteger(record.chainId) || record.chainId <= 0 ||
          !/^0x[0-9a-f]{40}$/.test(record.router) || !/^\d+$/.test(record.startBlock)) {
        throw new Error('Router watcher journal contains a duplicate or invalid scope record.');
      }
      this.seen.add('scope');
      this.scope = record;
    }
    if (record.type === 'event' || record.type === 'cursor' || record.type === 'delivery' || record.type === 'delivery_attempt') this.seen.add(record.id);
    if (record.type === 'alert') {
      this.seen.add(record.alert.id);
      this.alerts.set(record.alert.id, record.alert);
    }
    if (record.type === 'delivery') this.delivered.add(record.alertId);
    if (record.type === 'delivery_attempt') {
      this.deliveryAttempts.set(record.alertId, { count: record.attempt, nextAttemptAt: Date.parse(record.nextAttemptAt) });
    }
    if (record.type === 'cursor') {
      if (!/^\d+$/.test(record.nextBlock) || !/^\d+$/.test(record.checkpointBlock) ||
          !/^0x[0-9a-f]{64}$/i.test(record.checkpointHash) || BigInt(record.nextBlock) !== BigInt(record.checkpointBlock) + 1n) {
        throw new Error('Router watcher journal contains an invalid cursor record.');
      }
      this.nextBlock = BigInt(record.nextBlock);
      this.checkpoint = { blockNumber: BigInt(record.checkpointBlock), hash: record.checkpointHash.toLowerCase() };
    }
  }

  private append(record: JournalRecord, id: string): boolean {
    if (this.seen.has(id)) return false;
    if (this.fd === undefined) throw new Error('Router watcher journal is closed.');
    if (this.failed) throw new Error('Router watcher journal previously failed; restart after reviewing the final line.');
    try {
      writeAllSync(this.fd, `${JSON.stringify(record)}\n`);
      fsyncSync(this.fd);
    } catch (error) {
      this.failed = true;
      throw error;
    }
    this.loadRecord(record);
    return true;
  }

  appendEvent(record: Omit<EventRecord, 'type'>): boolean {
    return this.append({ type: 'event', ...record }, record.id);
  }

  appendAlert(alert: WatchAlert): boolean {
    return this.append({ type: 'alert', alert }, alert.id);
  }

  advance(nextBlock: bigint, checkpointBlock: bigint, checkpointHash: string): void {
    if (nextBlock !== checkpointBlock + 1n || !/^0x[0-9a-f]{64}$/i.test(checkpointHash)) {
      throw new Error('Router watcher checkpoint is invalid.');
    }
    if (this.nextBlock !== undefined && nextBlock <= this.nextBlock) return;
    const id = `cursor:${nextBlock}`;
    this.append({ type: 'cursor', id, nextBlock: nextBlock.toString(), checkpointBlock: checkpointBlock.toString(),
      checkpointHash: checkpointHash.toLowerCase(), updatedAt: new Date().toISOString() }, id);
  }

  markDelivered(alertId: string): void {
    const id = `delivery:${alertId}`;
    this.append({ type: 'delivery', id, alertId, deliveredAt: new Date().toISOString() }, id);
  }

  beginDelivery(alertId: string, now: Date): void {
    const attempt = (this.deliveryAttempts.get(alertId)?.count ?? 0) + 1;
    const delayMs = Math.min(60 * 60_000, 15_000 * 2 ** Math.min(attempt - 1, 8));
    const record: DeliveryAttemptRecord = { type: 'delivery_attempt', id: `delivery-attempt:${alertId}:${attempt}`,
      alertId, attempt, nextAttemptAt: new Date(now.getTime() + delayMs).toISOString() };
    this.append(record, record.id);
  }

  state(now = new Date()): WatchJournalState {
    const outstanding = [...this.alerts.values()].filter((alert) => !this.delivered.has(alert.id));
    return {
      nextBlock: this.nextBlock,
      checkpoint: this.checkpoint,
      pendingAlerts: outstanding.filter((alert) => (this.deliveryAttempts.get(alert.id)?.nextAttemptAt ?? 0) <= now.getTime()),
      unacknowledgedAlerts: outstanding.length,
    };
  }

  close(): void {
    if (this.fd === undefined) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = undefined;
    unlinkSync(this.lockPath);
    const dirFd = openSync(dirname(this.path), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
}
