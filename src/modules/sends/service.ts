import { and, eq } from 'drizzle-orm';
import { maxUint256 } from 'viem';
import { config } from '../../config.js';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { contacts, escrows, intents, users } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { isAddress, normAddress } from '../../lib/chain.js';
import { encrypt, phoneHmac, randomCode } from '../../lib/crypto.js';
import { errors } from '../../lib/errors.js';
import { parseAmount } from '../../lib/money.js';
import { normalizePhone } from '../../lib/phone.js';
import { consume, limits } from '../../lib/rateLimit.js';
import {
  getEscrowFee, isNativeRouterToken, newRouterId, serializeRouterAuth, signEscrowAuth,
  type EscrowAuth,
} from '../../lib/router.js';
import type { AuthUser } from '../../plugins/auth.js';
import { isTokenInsolvent } from '../escrows/solvency.js';
import { assertRouterOperationEnabled } from '../escrows/incident.js';
import { cleanNote } from '../intents/service.js';
import { lockPhoneMutation } from '../phone/lock.js';
import { recipientRef } from '../resolve/recipientRef.js';
import { isPhoneDiscoveryGrantCurrent, requirePhoneDiscoveryGrant } from '../resolve/service.js';
import { assertMinAmount } from '../tokens/minimum.js';
import { getToken } from '../tokens/registry.js';

export type AuthorizeSendInput = {
  phone: string; tokenAddress: string; amount: string; expectedSenderAddress: string; contactId?: string; note?: string;
  expectedRecipientRef: string | null;
};

async function insertEscrowWithUniqueCode(tx: DbTransaction, values: Omit<typeof escrows.$inferInsert, 'code'>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode(10);
    const [legacy] = await tx.select({ id: intents.id }).from(intents).where(eq(intents.code, code)).limit(1);
    if (legacy) continue;
    const [row] = await tx.insert(escrows).values({ ...values, code })
      .onConflictDoNothing({ target: escrows.code }).returning();
    if (row) return row;
  }
  throw new Error('Could not allocate a unique escrow code after repeated collisions.');
}

export async function authorizeSend(user: AuthUser, input: AuthorizeSendInput, ipHash: string) {
  await assertRouterOperationEnabled('authorizations');
  if (!isAddress(input.expectedSenderAddress)) throw errors.invalidAddress('Enter the sending wallet address again.');
  if (normAddress(input.expectedSenderAddress) !== normAddress(user.address)) {
    throw errors.conflict('Your PingApp session changed. Reconnect the original sending wallet and sign in.');
  }
  const phone = normalizePhone(input.phone);
  const targetHmac = phoneHmac(phone.e164);
  const discoveryGrant = await requirePhoneDiscoveryGrant(user.id, targetHmac, ipHash);
  const token = await getToken(input.tokenAddress);
  if (!token) throw errors.unknownToken();
  if (await isTokenInsolvent(token.address)) {
    throw errors.conflict('Sending this token is paused while PingApp checks its escrow balance. Try another token.');
  }
  const amount = parseAmount(input.amount, token.decimals);
  if (amount > maxUint256) throw errors.invalidAmount();
  await assertMinAmount(token, amount, { tolerancePct: 0 });
  const note = cleanNote(input.note);
  const fee = await getEscrowFee();
  const claimTip = BigInt(config.ESCROW_CLAIM_TIP_WEI);
  const router = normAddress(config.ROUTER_ADDRESS);
  const native = isNativeRouterToken(token.address);
  const approval = native ? null : { token: token.address, spender: router, amount: amount.toString() };

  return db.transaction(async (tx) => {
    // The same first lock as phone linking, readiness and account deletion.
    await lockPhoneMutation(tx);
    const [sender] = await tx.select().from(users).where(and(
      eq(users.id, user.id), eq(users.address, normAddress(user.address)),
    )).limit(1).for('update');
    if (!sender) throw errors.unauthenticated();
    if (sender.phoneHmac === targetHmac) throw errors.selfSend();
    const [recipient] = await tx.select().from(users).where(eq(users.phoneHmac, targetHmac)).limit(1);
    let contactName: string | null = null;
    if (input.contactId) {
      const [contact] = await tx.select({ name: contacts.name }).from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.userId, user.id))).limit(1);
      if (!contact) throw errors.validation('This contact is unavailable.');
      contactName = contact.name;
    }
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + config.ROUTER_AUTH_TTL_SECONDS);
    const id = newRouterId();
    if (!isPhoneDiscoveryGrantCurrent(discoveryGrant, recipient ?? null)) {
      throw errors.conflict('Look up this recipient again before sending.');
    }
    const binding = recipient ? recipientRef(sender.address, targetHmac, recipient) : null;
    if (input.expectedRecipientRef !== binding) {
      throw errors.conflict('The recipient changed. Review the phone number again before sending.');
    }
    const deliveryMode = recipient ? 'automatic' as const : 'claim' as const;
    if (!recipient) {
      if (!sender.displayName) throw errors.displayNameRequired();
      await consume(limits.intentUserDay, sender.id);
    }
    const expiresAt = BigInt(now + config.INTENT_TTL_DAYS * 86400);
    const auth: EscrowAuth = { id, sender: normAddress(sender.address), token: normAddress(token.address),
      amount, claimTip, expiresAt, deadline };
    const escrow = await insertEscrowWithUniqueCode(tx, {
      id, senderUserId: sender.id, senderAddress: auth.sender, recipientPhoneHmac: targetHmac,
      recipientPhoneEnc: encrypt(phone.e164), recipientPhoneMasked: phone.masked,
      deliveryMode, recipientRef: binding, contactName,
      tokenAddress: token.address, amountRaw: amount.toString(), claimTipWei: claimTip.toString(), feeWei: fee.toString(),
      expiresAt: new Date(Number(expiresAt) * 1000), authDeadline: new Date(Number(deadline) * 1000), note,
      status: 'authorized', smsStatus: recipient ? 'not_required' : 'failed',
    });
    await assertRouterOperationEnabled('authorizations', tx);
    const signature = await signEscrowAuth(auth);
    await audit('send_authorized', { userId: sender.id, data: { routerId: id, mode: 'escrow' }, ipHash }, tx);
    return { mode: 'escrow' as const, deliveryMode, escrowId: escrow.id, router, auth: serializeRouterAuth(auth), signature,
      value: ((native ? amount : 0n) + claimTip + fee).toString(), approval,
      feeWei: fee.toString(), claimTipWei: claimTip.toString(), expiresAt: escrow.expiresAt.toISOString() };
  });
}
