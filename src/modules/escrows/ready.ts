import { and, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { notify } from '../../db/notify.js';
import { escrows, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { recipientRef } from '../resolve/recipientRef.js';

export function matchesEscrowRecipient(escrow: typeof escrows.$inferSelect, recipient: typeof users.$inferSelect): boolean {
  if (recipient.phoneHmac !== escrow.recipientPhoneHmac || recipient.address === escrow.senderAddress ||
      recipient.id === escrow.senderUserId) return false;
  return escrow.deliveryMode !== 'automatic' || (recipient.phoneLinkedAt !== null &&
    escrow.recipientRef === recipientRef(escrow.senderAddress, escrow.recipientPhoneHmac, recipient));
}

/** Caller holds lockPhoneMutation as the first lock in its transaction. */
export async function markEscrowsClaimable(tx: DbTransaction, phoneHmac: string, userId: string): Promise<number> {
  const [recipient] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!recipient) return 0;
  const candidates = await tx.select().from(escrows).where(and(
    eq(escrows.recipientPhoneHmac, phoneHmac), eq(escrows.status, 'deposited'), gt(escrows.expiresAt, new Date()),
    or(isNull(escrows.senderUserId), ne(escrows.senderUserId, userId)), ne(escrows.senderAddress, recipient.address),
    or(isNull(escrows.recipientUserId), ne(escrows.recipientUserId, userId)),
  ));
  const changed = candidates.filter((row) => matchesEscrowRecipient(row, recipient));
  for (const row of changed) {
    await tx.update(escrows).set({ recipientUserId: userId }).where(eq(escrows.id, row.id));
    if (row.deliveryMode === 'claim') {
      if (row.senderUserId) await notify(row.senderUserId, 'escrow_ready', { escrowId: row.id }, tx);
      await notify(userId, 'escrow_incoming', { escrowId: row.id }, tx);
    }
  }
  return changed.length;
}

export async function clearEscrowRecipient(tx: DbTransaction, userId: string, phoneHmac: string): Promise<void> {
  await tx.update(escrows).set({ recipientUserId: null }).where(and(
    eq(escrows.recipientUserId, userId), eq(escrows.recipientPhoneHmac, phoneHmac), eq(escrows.status, 'deposited'),
  ));
}
