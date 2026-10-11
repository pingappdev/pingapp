import { db } from './client.js';
import { notifications } from './schema.js';
import type { DbOrTx } from './tx.js';

export type NotificationType =
  | 'escrow_ready' | 'escrow_incoming' | 'escrow_claimed' | 'escrow_received' | 'escrow_refunded'
  | 'intent_ready'
  | 'intent_expired'
  | 'intent_incoming'
  | 'transfer_received'
  | 'transfer_failed'
  | 'phone_claim_attempt'
  | 'phone_claim_resolved'
  | 'phone_removed_by_review';

export async function notify(
  userId: string,
  type: NotificationType,
  data: Record<string, unknown>,
  tx: DbOrTx = db,
): Promise<void> {
  await tx.insert(notifications).values({ userId, type, data });
}
