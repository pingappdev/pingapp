import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import { notify } from '../../db/notify.js';
import { intents, tokens, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { formatAmount } from '../../lib/money.js';

function displayName(name: string, address: string): string {
  return name || `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function markIntentsReady(tx: DbTransaction, phoneHmac: string, userId: string): Promise<number> {
  const changed = await tx.update(intents).set({
    status: 'ready', recipientUserId: userId, readyAt: new Date(),
  }).where(and(
    eq(intents.recipientPhoneHmac, phoneHmac), eq(intents.status, 'pending'),
    gt(intents.expiresAt, new Date()), ne(intents.senderUserId, userId),
  )).returning({ id: intents.id });
  if (!changed.length) return 0;

  const sender = users;
  const rows = await tx.select({
    id: intents.id, amountRaw: intents.amountRaw,
    senderId: sender.id, senderName: sender.displayName, senderAddress: sender.address,
    tokenSymbol: tokens.symbol, tokenDecimals: tokens.decimals,
  }).from(intents)
    .innerJoin(sender, eq(sender.id, intents.senderUserId))
    .innerJoin(tokens, eq(tokens.address, intents.tokenAddress))
    .where(inArray(intents.id, changed.map((row) => row.id)));
  const [recipient] = await tx.select({ name: users.displayName, address: users.address })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!recipient || rows.length !== changed.length) throw new Error('Ready intent details missing.');
  const recipientDisplayName = displayName(recipient.name, recipient.address);
  for (const row of rows) {
    const amount = formatAmount(row.amountRaw, row.tokenDecimals);
    const senderDisplayName = displayName(row.senderName, row.senderAddress);
    await notify(row.senderId, 'intent_ready', {
      intentId: row.id, recipientDisplayName, amount, symbol: row.tokenSymbol,
    }, tx);
    await notify(userId, 'intent_incoming', {
      intentId: row.id, senderDisplayName, amount, symbol: row.tokenSymbol,
    }, tx);
  }
  return changed.length;
}
