import { db } from './client.js';
import { auditEvents } from './schema.js';
import type { DbOrTx } from './tx.js';

export type AuditOptions = {
  userId?: string | null;
  data?: Record<string, unknown>;
  ipHash?: string | null;
};

/**
 * Store an audit event. Never include raw phone numbers in `data`; use
 * `phoneMasked` or `phoneHmac` instead.
 */
export async function audit(type: string, opts: AuditOptions = {}, tx: DbOrTx = db): Promise<void> {
  await tx.insert(auditEvents).values({
    userId: opts.userId ?? null,
    type,
    data: opts.data ?? {},
    ipHash: opts.ipHash ?? null,
  });
}
