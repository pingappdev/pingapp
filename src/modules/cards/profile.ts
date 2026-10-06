import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { cardProfiles, users } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { emailInput } from './domain.js';
import { decryptCardData, encryptCardData } from './settings.js';

export async function getProfile(userId: string) {
  const [row] = await db.select().from(cardProfiles).where(eq(cardProfiles.userId, userId)).limit(1);
  return row ? { email: decryptCardData(row.emailEnc, `profile:${userId}`) } : null;
}
export async function saveProfile(userId: string, value: string) {
  const email = emailInput(value);
  const emailEnc = encryptCardData(email, `profile:${userId}`);
  await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) throw errors.unauthenticated();
    await tx.insert(cardProfiles).values({ userId, emailEnc }).onConflictDoUpdate({
      target: cardProfiles.userId, set: { emailEnc, updatedAt: new Date() },
    });
  });
  return { email };
}
