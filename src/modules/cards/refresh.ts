import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { cards, kv, type Card } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { cardsEnabled, providerScope } from './settings.js';

export const balanceRefreshKey = (cardId: string) => `cards:balance-refresh:${cardId}`;
const staleAfterMs = 30_000;

export function shouldScheduleBalanceRead(card: Card, now = new Date()): boolean {
  return card.issueStatus === 'issued' && card.providerCardId !== null &&
    (!card.balanceAsOf || now.getTime() - card.balanceAsOf.getTime() >= staleAfterMs) &&
    card.nextSyncAt > now && (!card.syncLeaseUntil || card.syncLeaseUntil <= now);
}

// The caller holds the card row lock. Invalidate any older in-flight response before
// requesting an authoritative read; a process restart must not lose the live flag.
export async function requestBalanceRefresh(tx: DbTransaction, cardId: string) {
  await tx.update(cards).set({ nextSyncAt: new Date(), syncToken: null, syncLeaseUntil: null }).where(eq(cards.id, cardId));
  const value = { live: true };
  await tx.insert(kv).values({ key: balanceRefreshKey(cardId), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

export async function scheduleStaleBalanceReads(userId: string, ids: string[]) {
  if (!cardsEnabled() || !ids.length) return;
  await db.transaction(async (tx) => {
    // Skip busy rows; repeated browser polls coalesce and never bypass a worker lease/backoff.
    const rows = await tx.select().from(cards).where(and(eq(cards.userId, userId), eq(cards.providerScope, providerScope), inArray(cards.id, ids)))
      .orderBy(asc(cards.id)).for('update', { skipLocked: true });
    const now = new Date();
    for (const card of rows) if (shouldScheduleBalanceRead(card, now)) await requestBalanceRefresh(tx, card.id);
  });
}
