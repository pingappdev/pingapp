import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { escrows, tokens, users } from '../../db/schema.js';
import { formatAmount } from '../../lib/money.js';

export async function getEscrowClaim(code: string) {
  const [row] = await db.select({ escrow: escrows, token: tokens, senderName: users.displayName }).from(escrows)
    .innerJoin(tokens, eq(tokens.address, escrows.tokenAddress))
    .leftJoin(users, eq(users.id, escrows.senderUserId)).where(eq(escrows.code, code)).limit(1);
  if (!row) return null;
  return {
    kind: 'escrow' as const, id: row.escrow.id, status: row.escrow.status,
    senderDisplayName: row.senderName || 'A PingApp user',
    token: { symbol: row.token.symbol, name: row.token.name, logoUrl: row.token.logoUrl, decimals: row.token.decimals },
    amount: formatAmount(row.escrow.amountRaw, row.token.decimals), note: row.escrow.note,
    recipientPhoneMasked: row.escrow.recipientPhoneMasked, expiresAt: row.escrow.expiresAt.toISOString(),
  };
}
