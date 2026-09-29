import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { notify } from '../../db/notify.js';
import { intents, tokens, users } from '../../db/schema.js';
import type { WorkerCtx } from '../../lib/modules.js';
import { formatAmount } from '../../lib/money.js';
import { lockPhoneMutation } from '../phone/lock.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

async function expireIntents(): Promise<number> {
  return db.transaction(async (tx) => {
    // Keep the same first-lock order as phone linking and intent creation.
    await lockPhoneMutation(tx);
    const now = new Date();
    const expired = await tx.update(intents).set({ status: 'expired' }).where(and(
      inArray(intents.status, ['pending', 'ready']),
      lt(intents.expiresAt, now),
    )).returning({ id: intents.id });
    if (!expired.length) return 0;

    const rows = await tx.select({
      id: intents.id,
      senderId: intents.senderUserId,
      recipientPhoneMasked: intents.recipientPhoneMasked,
      amountRaw: intents.amountRaw,
      symbol: tokens.symbol,
      decimals: tokens.decimals,
    }).from(intents)
      .innerJoin(tokens, eq(tokens.address, intents.tokenAddress))
      .innerJoin(users, eq(users.id, intents.senderUserId))
      .where(inArray(intents.id, expired.map((row) => row.id)));
    if (rows.length !== expired.length) throw new Error('Expired intent notification details are missing.');

    for (const row of rows) {
      await notify(row.senderId, 'intent_expired', {
        intentId: row.id,
        recipientPhoneMasked: row.recipientPhoneMasked,
        amount: formatAmount(row.amountRaw, row.decimals),
        symbol: row.symbol,
      }, tx);
    }
    return expired.length;
  });
}

export default async function registerJobs(ctx: WorkerCtx): Promise<void> {
  ctx.process('intents', 'expire', async () => expireIntents());
  await ctx.schedule('intents', 'expire', FIFTEEN_MINUTES);
}
