import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { cardProfiles, users } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { emailInput, requireExpectedAccount } from './domain.js';
import { cardholderNameSchema, nextProfileUpdatedAt } from './products.js';
import { decryptCardData, encryptCardData } from './settings.js';

function serializeProfile(row: typeof cardProfiles.$inferSelect) {
  return {
    email: decryptCardData(row.emailEnc, `profile:${row.userId}`),
    cardholderName: row.cardholderNameEnc ? decryptCardData(row.cardholderNameEnc, `profile-name:${row.userId}`) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function getProfile(userId: string) {
  const [row] = await db.select().from(cardProfiles).where(eq(cardProfiles.userId, userId)).limit(1);
  return row ? serializeProfile(row) : null;
}
export async function saveProfile(userId: string, input: { email: string; expectedUserId: string; cardholderName?: string | null }) {
  requireExpectedAccount(userId, input.expectedUserId);
  const email = emailInput(input.email);
  const name = cardholderNameSchema.parse(input.cardholderName);
  const emailEnc = encryptCardData(email, `profile:${userId}`);
  return db.transaction(async (tx) => {
    // Same lock as issuance/deletion: no issue can observe a partially updated profile.
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) throw errors.unauthenticated();
    const [previous] = await tx.select().from(cardProfiles).where(eq(cardProfiles.userId, userId)).limit(1);
    const cardholderNameEnc = name === undefined ? previous?.cardholderNameEnc ?? null : name === null ? null : encryptCardData(name, `profile-name:${userId}`);
    const updatedAt = nextProfileUpdatedAt(previous?.updatedAt ?? null);
    const [row] = await tx.insert(cardProfiles).values({ userId, emailEnc, cardholderNameEnc, updatedAt }).onConflictDoUpdate({
      target: cardProfiles.userId, set: { emailEnc, cardholderNameEnc, updatedAt },
    }).returning();
    return serializeProfile(row);
  });
}
