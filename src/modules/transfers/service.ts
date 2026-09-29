import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { audit } from '../../db/audit.js';
import { contacts, intents, transfers, users, type Transfer } from '../../db/schema.js';
import { isAddress, normAddress } from '../../lib/chain.js';
import { phoneHmac } from '../../lib/crypto.js';
import { errors } from '../../lib/errors.js';
import { enqueue } from '../../lib/queue.js';
import { normalizePhone } from '../../lib/phone.js';
import { assertMinAmount } from '../tokens/minimum.js';
import { getToken } from '../tokens/registry.js';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW_AMOUNT = /^[1-9]\d{0,77}$/;
const INTENT_MISMATCH = "This transfer doesn't match the pending send.";

export type TransferBody = {
  txHash: string;
  tokenAddress: string;
  amountRaw: string;
  toAddress: string;
  recipientPhone?: string;
  contactId?: string;
  intentId?: string;
};

type Sender = { id: string; address: string };

async function byHash(hash: string): Promise<Transfer | null> {
  const [row] = await db.select().from(transfers).where(eq(transfers.txHash, hash)).limit(1);
  return row ?? null;
}

function sameSender(row: Transfer, userId: string): Transfer {
  if (row.senderUserId !== userId) throw errors.conflict('This transaction is already recorded.');
  return row;
}

/** The unique transaction hash is the idempotency key, including simultaneous POSTs. */
export async function recordTransfer(user: Sender, body: TransferBody): Promise<{ row: Transfer; created: boolean }> {
  if (!HASH.test(body.txHash)) throw errors.validation('Enter a valid transaction hash.');
  if (!RAW_AMOUNT.test(body.amountRaw)) throw errors.invalidAmount();
  if (!isAddress(body.toAddress)) throw errors.invalidAddress();
  const toAddress = normAddress(body.toAddress);
  if (toAddress === normAddress(user.address)) throw errors.selfSend();
  const token = await getToken(body.tokenAddress);
  if (!token) throw errors.unknownToken();
  const hash = body.txHash.toLowerCase();

  const prior = await byHash(hash);
  if (prior) return { row: sameSender(prior, user.id), created: false };

  // Enforce the API contract for every recorded send, including intent completions.
  await assertMinAmount(token, BigInt(body.amountRaw), { tolerancePct: 10 });
  const phone = body.recipientPhone === undefined ? null : normalizePhone(body.recipientPhone);
  const recipientPhoneHmac = phone ? phoneHmac(phone.e164) : null;

  const result = await db.transaction(async (tx) => {
    // Locking the recipient first matches phone-linking's update order. It prevents
    // recording a stale phone or intent binding while that account changes phone.
    const [recipient] = await tx.select().from(users)
      .where(eq(users.address, toAddress)).limit(1).for('update');
    if (recipientPhoneHmac && recipient?.phoneHmac !== recipientPhoneHmac) {
      throw errors.validation('This phone number no longer points to that wallet. Please review the recipient again.');
    }

    let contactName: string | null = null;
    if (body.contactId) {
      const [contact] = await tx.select({ name: contacts.name }).from(contacts)
        .where(and(eq(contacts.id, body.contactId), eq(contacts.userId, user.id))).limit(1);
      if (!contact) throw errors.validation('This contact is unavailable.');
      contactName = contact.name;
    }

    if (body.intentId) {
      const [intent] = await tx.select().from(intents)
        .where(eq(intents.id, body.intentId)).limit(1).for('update');
      // A competing POST for this hash may have committed while we waited for the intent.
      const [committed] = await tx.select().from(transfers).where(eq(transfers.txHash, hash)).limit(1);
      if (committed) return { row: sameSender(committed, user.id), created: false };
      if (!intent || intent.senderUserId !== user.id || intent.status !== 'ready' ||
          intent.expiresAt <= new Date() || intent.tokenAddress !== token.address ||
          intent.amountRaw !== body.amountRaw || intent.recipientUserId !== recipient?.id ||
          recipient?.phoneHmac !== intent.recipientPhoneHmac) {
        throw errors.validation(INTENT_MISMATCH);
      }
      const [active] = await tx.select({ id: transfers.id }).from(transfers)
        .where(and(eq(transfers.intentId, intent.id), inArray(transfers.status, ['submitted', 'confirmed'])))
        .limit(1);
      if (active) throw errors.validation(INTENT_MISMATCH);
    }

    const [inserted] = await tx.insert(transfers).values({
      senderUserId: user.id,
      senderAddress: normAddress(user.address),
      recipientAddress: toAddress,
      recipientUserId: recipient?.id ?? null,
      recipientPhoneHmac,
      recipientPhoneMasked: phone?.masked ?? null,
      tokenAddress: token.address,
      amountRaw: body.amountRaw,
      txHash: hash,
      status: 'submitted',
      contactName,
      intentId: body.intentId ?? null,
    }).onConflictDoNothing({ target: transfers.txHash }).returning();
    if (!inserted) {
      const [existing] = await tx.select().from(transfers).where(eq(transfers.txHash, hash)).limit(1);
      if (!existing) throw errors.internal();
      return { row: sameSender(existing, user.id), created: false };
    }
    await audit('transfer_recorded', { userId: user.id, data: { transferId: inserted.id, token: token.symbol } }, tx);
    return { row: inserted, created: true };
  });

  if (result.created) {
    await enqueue('transfers', 'confirm', { transferId: result.row.id, attempt: 0 }, {
      delay: 4000, jobId: `confirm-${result.row.id}-0`,
    });
  }
  return result;
}
