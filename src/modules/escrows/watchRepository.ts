import postgres from 'postgres';
import type { WatchAuthorization, WatchEscrow, WatchMetrics, WatchRepository } from './watcher.js';

type ReadRow = Record<string, unknown>;
type ReadTransaction = {
  unsafe<T extends ReadRow = ReadRow>(query: string, parameters?: unknown[]): Promise<T[]>;
};
type ReadClient = {
  begin<T>(callback: (tx: ReadTransaction) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
};

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asCount(value: unknown): number {
  return Number(value ?? 0);
}

export class ReadOnlyRouterWatchRepository implements WatchRepository {
  private readonly client: ReadClient;

  constructor(databaseUrl: string) {
    this.client = postgres(databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 10, prepare: false }) as unknown as ReadClient;
  }

  private read<T>(fn: (tx: ReadTransaction) => Promise<T>): Promise<T> {
    return this.client.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      return fn(tx);
    });
  }

  async verifyReadOnlyRole(): Promise<void> {
    const [row] = await this.read((tx) => tx.unsafe<{
      superuser: boolean; can_create_role: boolean; can_create_db: boolean; can_bypass_rls: boolean; can_replicate: boolean;
      can_create_in_public: boolean; can_create_any_schema: boolean; can_create_database_objects: boolean;
      can_write_public_tables: boolean; owns_public_relation: boolean; has_role_memberships: boolean;
    }>(`SELECT r.rolsuper AS superuser, r.rolcreaterole AS can_create_role,
        r.rolcreatedb AS can_create_db, r.rolbypassrls AS can_bypass_rls, r.rolreplication AS can_replicate,
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public,
        coalesce((SELECT bool_or(has_table_privilege(current_user, c.oid, 'INSERT') OR
            has_table_privilege(current_user, c.oid, 'UPDATE') OR has_table_privilege(current_user, c.oid, 'DELETE') OR
            has_table_privilege(current_user, c.oid, 'TRUNCATE'))
          FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')), false)
          AS can_write_public_tables,
        coalesce((SELECT bool_or(c.relowner = r.oid) FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')), false)
          AS owns_public_relation,
        coalesce((SELECT bool_or(has_schema_privilege(current_user, n.oid, 'CREATE')) FROM pg_namespace n
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'), false)
          AS can_create_any_schema,
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_objects,
        EXISTS (SELECT 1 FROM pg_roles granted WHERE granted.oid <> r.oid AND pg_has_role(current_user, granted.oid, 'MEMBER'))
          AS has_role_memberships
      FROM pg_roles r WHERE r.rolname = current_user`));
    if (!row || row.superuser || row.can_create_role || row.can_create_db || row.can_bypass_rls || row.can_replicate ||
        row.can_create_in_public || row.can_create_any_schema || row.can_create_database_objects ||
        row.can_write_public_tables || row.owns_public_relation || row.has_role_memberships) {
      throw new Error('Router watcher database role must be non-privileged and SELECT-only on public tables.');
    }
    await this.read(async (tx) => {
      await tx.unsafe('SELECT key FROM public.kv LIMIT 1');
    });
  }

  async getEscrow(id: string): Promise<WatchEscrow | null> {
    return this.read(async (tx) => {
      const [row] = await tx.unsafe<{
        id: string; token_address: string; amount_raw: string; claim_tip_wei: string; status: string;
      }>(`SELECT id, token_address, amount_raw, claim_tip_wei, status FROM public.escrows WHERE id = $1 LIMIT 1`, [id]);
      return row ? { id: row.id, tokenAddress: row.token_address, amountRaw: row.amount_raw,
        claimTipWei: row.claim_tip_wei, status: row.status } : null;
    });
  }

  async getClaimAuthorizations(id: string): Promise<WatchAuthorization[]> {
    return this.read(async (tx) => {
      const rows = await tx.unsafe<{
        request_id: string; escrow_id: string; kind: string; recipient_address: string; relayer_address: string;
        deadline: Date; signed_at: Date; domain_name: string; domain_version: string; domain_chain_id: string;
        domain_verifying_contract: string; typed_data_digest: string;
      }>(`SELECT request_id, escrow_id, kind, recipient_address, relayer_address, deadline, signed_at,
          domain_name, domain_version, domain_chain_id::text, domain_verifying_contract, typed_data_digest
        FROM public.claim_authorizations WHERE escrow_id = $1`, [id]);
      return rows.map((row) => ({ requestId: row.request_id, escrowId: row.escrow_id, kind: row.kind,
        recipientAddress: row.recipient_address, relayerAddress: row.relayer_address, deadline: asDate(row.deadline),
        signedAt: asDate(row.signed_at), domainName: row.domain_name, domainVersion: row.domain_version,
        domainChainId: BigInt(row.domain_chain_id), domainVerifyingContract: row.domain_verifying_contract,
        typedDataDigest: row.typed_data_digest }));
    });
  }

  async getMetrics(since: Date, staleBefore: Date): Promise<WatchMetrics> {
    return this.read(async (tx) => {
      const [indexer] = await tx.unsafe<{ value: unknown }>(`SELECT value FROM public.kv WHERE key = 'router:lastBlock'`);
      const [signing] = await tx.unsafe<{ count: string }>(`SELECT
        (SELECT count(*) FROM public.claim_authorizations WHERE signed_at >= $1) +
        (SELECT count(*) FROM public.audit_events WHERE type = 'send_authorized' AND created_at >= $1) AS count`, [since]);
      const [stuck] = await tx.unsafe<{ count: string }>(`SELECT count(DISTINCT e.id) AS count
        FROM public.escrows e WHERE e.status = 'claiming'
          AND EXISTS (SELECT 1 FROM public.claim_authorizations a WHERE a.escrow_id = e.id AND a.signed_at <= $1)
          AND NOT EXISTS (SELECT 1 FROM public.claim_authorizations a WHERE a.escrow_id = e.id AND a.signed_at > $1)`, [staleBefore]);
      const [deferred] = await tx.unsafe<{ count: string }>(`SELECT count(*) AS count FROM public.escrows
        WHERE status = 'deposited' AND expires_at > now() AND sms_status = 'deferred_budget'`);
      const [unknown] = await tx.unsafe<{ count: string }>(`SELECT count(*) AS count FROM public.escrows
        WHERE status = 'deposited' AND expires_at > now() AND sms_status = 'provider_unknown'`);
      const open = await tx.unsafe<{
        id: string; token_address: string; amount_raw: string; claim_tip_wei: string; status: string;
      }>(`SELECT id, token_address, amount_raw, claim_tip_wei, status FROM public.escrows
        WHERE status IN ('authorized', 'deposited', 'claiming') ORDER BY created_at LIMIT 1001`);
      const indexerValue = indexer?.value;
      const indexerNextBlock = typeof indexerValue === 'string' && /^\d+$/.test(indexerValue)
        ? BigInt(indexerValue) : typeof indexerValue === 'number' && Number.isSafeInteger(indexerValue)
          ? BigInt(indexerValue) : null;
      return {
        indexerNextBlock,
        signingLastHour: asCount(signing?.count),
        stuckClaims: asCount(stuck?.count),
        smsBudgetDeferred: asCount(deferred?.count),
        smsProviderUnknown: asCount(unknown?.count),
        openEscrows: open.slice(0, 1000).map((row) => ({ id: row.id, tokenAddress: row.token_address,
          amountRaw: row.amount_raw, claimTipWei: row.claim_tip_wei, status: row.status })),
        solvencyScopeExceeded: open.length > 1000,
      };
    });
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
