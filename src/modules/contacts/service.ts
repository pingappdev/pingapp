import { and, asc, count, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { contacts, users } from '../../db/schema.js';
import { decrypt, encrypt, phoneHmac } from '../../lib/crypto.js';
import { AppError, errors } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import type { DbTransaction } from '../../db/tx.js';

const MAX_CONTACTS_PER_USER = 500;
const PHONE_UNIQUE_CONSTRAINT = 'contacts_user_phone_hmac_unique_idx';

export type ContactInput = {
  name?: string;
  phone?: string;
};

type ContactRow = typeof contacts.$inferSelect;

function normalizeName(value: string | undefined, current?: string): string {
  const name = (value ?? current ?? '').trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 80) {
    throw errors.validation('Name must be between 1 and 80 characters.');
  }
  return name;
}

async function lockContactMutations(tx: DbTransaction, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(
    hashtextextended('pingapp:contact-mutation:' || ${userId}, 0)
  )`);
}

async function lockUser(tx: DbTransaction, userId: string): Promise<void> {
  const [user] = await tx.select({ id: users.id }).from(users)
    .where(eq(users.id, userId)).for('update').limit(1);
  if (!user) throw errors.unauthenticated();
}

function contactConflict(error: unknown): AppError | null {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  // Drizzle may expose the postgres.js error directly or under `cause`.
  // Follow nested driver wrappers without depending on a single wrapping shape.
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const constraint = record.constraint_name ?? record.constraintName ?? record.constraint;

    if (record.code === '23505' && typeof constraint === 'string') {
      if (constraint === PHONE_UNIQUE_CONSTRAINT) {
        return errors.conflict('This phone number is already in your contacts.');
      }
      return null;
    }

    pending.push(record.cause, record.originalError, record.driverError);
  }

  return null;
}

function throwContactConflict(error: unknown): never {
  const mapped = contactConflict(error);
  if (mapped) throw mapped;
  throw error;
}

function contactDto(row: ContactRow & {
  paId?: string | null;
  paName?: string | null;
}) {
  let onPingApp: null | { displayName: string } = null;
  if (row.paId) {
    onPingApp = {
      displayName: row.paName ?? '',
    };
  }

  return {
    id: row.id,
    name: row.name,
    phone: decrypt(row.phoneEnc),
    phoneMasked: row.phoneMasked,
    onPingApp,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function list(userId: string) {
  const rows = await db.select({
    contact: contacts,
    paId: users.id,
    paName: users.displayName,
  }).from(contacts)
    .leftJoin(users, eq(users.phoneHmac, contacts.phoneHmac))
    .where(eq(contacts.userId, userId))
    .orderBy(asc(sql`lower(${contacts.name})`), asc(contacts.createdAt));

  return rows.map((row) => contactDto({
    ...row.contact,
    paId: row.paId,
    paName: row.paName,
  }));
}

async function readContact(userId: string, contactId: string) {
  const [row] = await db.select({
    contact: contacts,
    paId: users.id,
    paName: users.displayName,
  }).from(contacts)
    .leftJoin(users, eq(users.phoneHmac, contacts.phoneHmac))
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .limit(1);
  if (!row) throw errors.notFound('Contact not found.');
  return contactDto({
    ...row.contact,
    paId: row.paId,
    paName: row.paName,
  });
}

export async function create(userId: string, input: ContactInput) {
  const name = normalizeName(input.name);
  if (input.phone == null) throw errors.validation('Add a phone number.');
  const normalizedPhone = normalizePhone(input.phone);

  try {
    const contactId = await db.transaction(async (tx) => {
      await lockContactMutations(tx, userId);
      await lockUser(tx, userId);

      const [currentCount] = await tx.select({ value: count() }).from(contacts)
        .where(eq(contacts.userId, userId));
      if (currentCount.value >= MAX_CONTACTS_PER_USER) {
        throw errors.validation('Your contact book is full.');
      }

      const [inserted] = await tx.insert(contacts).values({
        userId,
        name,
        phoneHmac: phoneHmac(normalizedPhone.e164),
        phoneEnc: encrypt(normalizedPhone.e164),
        phoneMasked: normalizedPhone.masked,
      }).returning();
      return inserted.id;
    });
    return readContact(userId, contactId);
  } catch (error) {
    throwContactConflict(error);
  }
}

export async function update(userId: string, contactId: string, input: ContactInput) {
  try {
    const updatedId = await db.transaction(async (tx) => {
      await lockContactMutations(tx, userId);
      await lockUser(tx, userId);

      const [current] = await tx.select().from(contacts).where(and(
        eq(contacts.id, contactId), eq(contacts.userId, userId),
      )).for('update').limit(1);
      if (!current) throw errors.notFound('Contact not found.');

      const name = input.name === undefined ? current.name : normalizeName(input.name);
      const patch: Partial<typeof contacts.$inferInsert> = {
        name,
        updatedAt: new Date(),
      };
      if (input.phone !== undefined) {
        const phone = normalizePhone(input.phone);
        patch.phoneHmac = phoneHmac(phone.e164);
        patch.phoneEnc = encrypt(phone.e164);
        patch.phoneMasked = phone.masked;
      }

      const [updated] = await tx.update(contacts).set(patch).where(and(
        eq(contacts.id, contactId), eq(contacts.userId, userId),
      )).returning();
      return updated.id;
    });
    return readContact(userId, updatedId);
  } catch (error) {
    throwContactConflict(error);
  }
}

export async function remove(userId: string, contactId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockContactMutations(tx, userId);
    await lockUser(tx, userId);

    const [deleted] = await tx.delete(contacts).where(and(
      eq(contacts.id, contactId), eq(contacts.userId, userId),
    )).returning({ id: contacts.id });
    if (!deleted) throw errors.notFound('Contact not found.');
  });
}
