import { sql } from 'drizzle-orm';
import type { DbTransaction } from '../../db/tx.js';

/**
 * Acquire this as the FIRST lock in transactions that mutate phone ownership,
 * claims, or the pending/ready state tied to registration. BE-10 account
 * deletion and BE-17 claim approval/rejection must call it before locking any
 * user or claim row. BE-16 intent creation must call it before checking whether
 * the recipient is registered and hold it through the pending-intent insert;
 * commit before sending SMS. Do not hold this lock during operator input or
 * provider calls. Global serialization is deliberate for low-volume phone
 * operations and covers absent-owner and create-vs-link races.
 */
export async function lockPhoneMutation(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('pingapp:phone-mutation', 0))`);
}
