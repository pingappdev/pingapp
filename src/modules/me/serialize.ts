import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { phoneClaims, sessions, users } from '../../db/schema.js';
import { checksum } from '../../lib/chain.js';
import { decrypt } from '../../lib/crypto.js';
import { errors } from '../../lib/errors.js';

/** Serialize only the authenticated owner's private profile. */
export async function serializeMe(userId: string, sessionId: string): Promise<{
  id: string;
  address: `0x${string}`;
  displayName: string;
  createdAt: string;
  phone: null | { e164: string; masked: string; country: string; linkedAt: string };
  pendingClaim: null | { id: string; phoneMasked: string; status: 'pending_review'; createdAt: string };
  freshUntil: string | null;
}> {
  const [[user], [session], [claim]] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    db.select({ freshUntil: sessions.freshUntil }).from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId))).limit(1),
    db.select({ id: phoneClaims.id, phoneMasked: phoneClaims.phoneMasked, createdAt: phoneClaims.createdAt })
      .from(phoneClaims)
      .where(and(eq(phoneClaims.claimantUserId, userId), eq(phoneClaims.status, 'pending_review')))
      .orderBy(phoneClaims.createdAt).limit(1),
  ]);
  if (!user || !session) throw errors.unauthenticated();

  return {
    id: user.id,
    address: checksum(user.address),
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    phone: user.phoneEnc ? {
      e164: decrypt(user.phoneEnc),
      masked: user.phoneMasked!,
      country: user.phoneCountry!,
      linkedAt: user.phoneLinkedAt!.toISOString(),
    } : null,
    pendingClaim: claim ? {
      id: claim.id,
      phoneMasked: claim.phoneMasked,
      status: 'pending_review',
      createdAt: claim.createdAt.toISOString(),
    } : null,
    freshUntil: session.freshUntil?.toISOString() ?? null,
  };
}
