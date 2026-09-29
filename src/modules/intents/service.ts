import { and, count, desc, eq, gt, inArray, or } from 'drizzle-orm';
import { config } from '../../config.js';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { intents, tokens, users, type Intent, type Token } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { checksum } from '../../lib/chain.js';
import { encrypt, phoneHmac, randomCode } from '../../lib/crypto.js';
import { AppError, errors } from '../../lib/errors.js';
import { formatAmount, parseAmount } from '../../lib/money.js';
import { normalizePhone } from '../../lib/phone.js';
import { consume, limits } from '../../lib/rateLimit.js';
import { logger } from '../../lib/logger.js';
import { sendSms } from '../../lib/sms.js';
import { assertMinAmount, getMinAmountRaw } from '../tokens/minimum.js';
import { getPrices } from '../tokens/prices.js';
import { getToken } from '../tokens/registry.js';
import { toTokenDto, type TokenDto } from '../tokens/routes.js';
import { lockPhoneMutation } from '../phone/lock.js';

const OPEN_STATUSES = ['pending', 'ready'] as const;
const BASE62_CODE = /^[0-9A-Za-z]{10}$/;
const CODE_INSERT_ATTEMPTS = 5;
const INTENT_LIST_LIMIT = 100;
const RECENT_COMPLETED_MS = 30 * 24 * 60 * 60 * 1000;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

export type CreateIntentInput = {
  phone: string;
  tokenAddress: string;
  amount: string;
  note?: string;
};

export type IntentRecipient = { address: `0x${string}`; displayName: string };

export type IntentDto = {
  id: string;
  code: string;
  status: Intent['status'];
  smsStatus: Intent['smsStatus'];
  recipientPhoneMasked: string;
  recipient: IntentRecipient | null;
  token: TokenDto;
  amountRaw: string;
  amount: string;
  note: string | null;
  transferId: string | null;
  claimUrl: string;
  expiresAt: string;
  createdAt: string;
  readyAt: string | null;
  completedAt: string | null;
};

export type IncomingIntentDto = {
  id: string;
  status: 'ready' | 'completed';
  sender: { address: `0x${string}`; displayName: string };
  token: TokenDto;
  amount: string;
  note: string | null;
  createdAt: string;
};

export type PublicClaimDto = {
  status: Intent['status'];
  senderDisplayName: string;
  token: { symbol: string; name: string; logoUrl: string | null; decimals: number };
  amount: string;
  note: string | null;
  recipientPhoneMasked: string;
  expiresAt: string;
};

function cleanNote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const note = value.trim().replace(CONTROL_CHARACTERS, '').trim();
  if ([...note].length > 140) {
    throw errors.validation('Notes must be 140 characters or fewer.');
  }
  return note || null;
}

function smsName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9 .'_-]/g, '').slice(0, 20).trim();
  return safe || 'A PingApp user';
}

function smsAmount(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  const short = fraction.slice(0, 6).replace(/0+$/, '');
  return short ? `${whole}.${short}` : whole;
}

function effectiveStatus(intent: Intent): Intent['status'] {
  if (OPEN_STATUSES.includes(intent.status as (typeof OPEN_STATUSES)[number]) && intent.expiresAt <= new Date()) {
    return 'expired';
  }
  return intent.status;
}

function recipientDto(address: string | null, name: string | null): IntentRecipient | null {
  if (!address) return null;
  const displayName = name || `${address.slice(0, 6)}…${address.slice(-4)}`;
  return { address: checksum(address), displayName };
}

async function tokenDto(token: Token, prices?: Map<string, string | null>): Promise<TokenDto> {
  const currentPrices = prices ?? await getPrices();
  const price = currentPrices.get(token.address) ?? null;
  const minRaw = await getMinAmountRaw(token, price);
  return toTokenDto(token, price, minRaw);
}

export async function toIntentDto(
  intent: Intent,
  token: Token,
  recipient: IntentRecipient | null = null,
  prices?: Map<string, string | null>,
): Promise<IntentDto> {
  return {
    id: intent.id,
    code: intent.code,
    status: effectiveStatus(intent),
    smsStatus: intent.smsStatus,
    recipientPhoneMasked: intent.recipientPhoneMasked,
    recipient,
    token: await tokenDto(token, prices),
    amountRaw: intent.amountRaw,
    amount: formatAmount(intent.amountRaw, token.decimals),
    note: intent.note,
    transferId: intent.transferId,
    claimUrl: `${config.APP_URL.replace(/\/$/, '')}/claim/${intent.code}`,
    expiresAt: intent.expiresAt.toISOString(),
    createdAt: intent.createdAt.toISOString(),
    readyAt: intent.readyAt?.toISOString() ?? null,
    completedAt: intent.completedAt?.toISOString() ?? null,
  };
}

function limitRejected(error: unknown): boolean {
  return error instanceof AppError && error.code === 'RATE_LIMITED';
}

function smsOutcome(error: unknown): Intent['smsStatus'] {
  if (error instanceof AppError && error.code === 'SMS_UNAVAILABLE' && error.details?.smsReason === 'disabled') {
    return 'disabled';
  }
  return 'failed';
}

async function insertIntentWithUniqueCode(
  tx: DbTransaction,
  values: Omit<typeof intents.$inferInsert, 'code'>,
): Promise<Intent> {
  for (let attempt = 0; attempt < CODE_INSERT_ATTEMPTS; attempt += 1) {
    const code = randomCode(10);
    const [inserted] = await tx.insert(intents).values({ ...values, code })
      .onConflictDoNothing({ target: intents.code }).returning();
    if (inserted) return inserted;
  }
  throw new Error('Could not allocate a unique intent code after repeated collisions.');
}

async function updateSmsStatus(
  tx: DbTransaction,
  intentId: string,
  senderId: string,
  smsStatus: Intent['smsStatus'],
): Promise<void> {
  await tx.update(intents).set({ smsStatus }).where(and(
    eq(intents.id, intentId), eq(intents.senderUserId, senderId),
  ));
}

export async function createIntent(
  senderId: string,
  input: CreateIntentInput,
  ipHash: string,
): Promise<IntentDto> {
  const phone = normalizePhone(input.phone);
  const targetPhoneHmac = phoneHmac(phone.e164);
  const token = await getToken(input.tokenAddress);
  if (!token) throw errors.unknownToken();
  const amountRaw = parseAmount(input.amount, token.decimals);
  await assertMinAmount(token, amountRaw, { tolerancePct: 0 });
  const note = cleanNote(input.note);

  const created = await db.transaction(async (tx) => {
    // This must be the first lock/DB operation. Linking and account deletion
    // use the same lock, so neither can miss the pending intent's readiness.
    await lockPhoneMutation(tx);
    const [sender] = await tx.select({
      id: users.id,
      displayName: users.displayName,
      phoneHmac: users.phoneHmac,
    }).from(users).where(eq(users.id, senderId)).for('update').limit(1);
    if (!sender) throw errors.unauthenticated();
    if (!sender.displayName) {
      throw new AppError('DISPLAY_NAME_REQUIRED', 400,
        'Add your name in Settings first, so the recipient knows who is sending.');
    }
    if (sender.phoneHmac === targetPhoneHmac) throw errors.selfSend();

    const [registered] = await tx.select({
      id: users.id,
      address: users.address,
      displayName: users.displayName,
    }).from(users).where(eq(users.phoneHmac, targetPhoneHmac)).limit(1);
    if (registered) {
      throw errors.conflict('This number is already on PingApp. Send to them directly.', {
        recipient: { address: checksum(registered.address), displayName: registered.displayName },
      });
    }

    const now = new Date();
    const [duplicate] = await tx.select({ id: intents.id }).from(intents).where(and(
      eq(intents.senderUserId, senderId),
      eq(intents.recipientPhoneHmac, targetPhoneHmac),
      eq(intents.tokenAddress, token.address),
      inArray(intents.status, [...OPEN_STATUSES]),
      gt(intents.expiresAt, now),
    )).limit(1);
    if (duplicate) {
      throw errors.conflict('You already have a pending send to this number.', { intentId: duplicate.id });
    }

    const [openCount] = await tx.select({ value: count() }).from(intents).where(and(
      eq(intents.senderUserId, senderId),
      inArray(intents.status, [...OPEN_STATUSES]),
      gt(intents.expiresAt, now),
    ));
    if (openCount.value >= 20) {
      throw new AppError('RATE_LIMITED', 429,
        'You have too many pending sends. Cancel some or wait for them to complete.');
    }

    // The advisory lock serializes this daily-limit check with simultaneous
    // creations from the same sender as well as duplicate/open-count checks.
    await consume(limits.intentUserDay, senderId);
    const expiresAt = new Date(now.getTime() + config.INTENT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const intent = await insertIntentWithUniqueCode(tx, {
      senderUserId: senderId,
      recipientPhoneHmac: targetPhoneHmac,
      recipientPhoneEnc: encrypt(phone.e164),
      recipientPhoneMasked: phone.masked,
      recipientUserId: null,
      tokenAddress: token.address,
      amountRaw: amountRaw.toString(),
      note,
      status: 'pending',
      // Conservative until the post-commit provider result is saved.
      smsStatus: 'failed',
      expiresAt,
    });
    return { intent, senderName: sender.displayName };
  });

  let smsStatus: Intent['smsStatus'] = 'failed';
  try {
    const [stillOpen] = await db.select({ id: intents.id }).from(intents).where(and(
      eq(intents.id, created.intent.id),
      eq(intents.senderUserId, senderId),
      eq(intents.status, 'pending'),
      gt(intents.expiresAt, new Date()),
    )).limit(1);
    if (!stillOpen) {
      smsStatus = 'failed';
    } else {
      // Short-circuit in order: a daily denial must not spend a 30-day slot.
      await consume(limits.intentPhoneSmsDay, targetPhoneHmac);
      await consume(limits.intentPhoneSms30d, targetPhoneHmac);
      const displayName = smsName(created.senderName);
      await sendSms({
        purpose: 'intent',
        toE164: phone.e164,
        phoneHmac: targetPhoneHmac,
        country: phone.country,
        text: `PingApp: ${displayName} wants to send you ${smsAmount(formatAmount(amountRaw, token.decimals))} ${token.symbol}. Link a wallet to receive it: ${config.APP_URL.replace(/\/$/, '')}/claim/${created.intent.code}`,
      });
      smsStatus = 'sent';
    }
  } catch (error) {
    smsStatus = limitRejected(error) ? 'skipped_rate_limit' : smsOutcome(error);
    logger.warn({ intentId: created.intent.id, smsStatus }, 'invite SMS failed; pending send remains available');
  }

  // Provider errors are deliberately converted into a stored status, never a
  // failed create response. Account deletion may have cascaded this row after
  // the first transaction; in that race an UPDATE affects no row and is safe.
  await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    await updateSmsStatus(tx, created.intent.id, senderId, smsStatus);
    await audit('intent_created', {
      userId: senderId,
      data: {
        intentId: created.intent.id,
        phoneMasked: phone.masked,
        symbol: token.symbol,
        smsStatus,
      },
      ipHash,
    }, tx);
  });

  return toIntentDto({ ...created.intent, smsStatus }, token);
}

export async function listIntents(senderId: string, status: 'open' | 'all' = 'open'): Promise<IntentDto[]> {
  const now = new Date();
  const rows = await db.select({
    intent: intents,
    token: tokens,
    recipientAddress: users.address,
    recipientName: users.displayName,
  }).from(intents)
    .innerJoin(tokens, eq(tokens.address, intents.tokenAddress))
    .leftJoin(users, eq(users.id, intents.recipientUserId))
    .where(and(
      eq(intents.senderUserId, senderId),
      status === 'open' ? and(inArray(intents.status, [...OPEN_STATUSES]), gt(intents.expiresAt, now)) : undefined,
    ))
    .orderBy(desc(intents.createdAt), desc(intents.id))
    .limit(INTENT_LIST_LIMIT);
  if (!rows.length) return [];

  const prices = await getPrices();
  return Promise.all(rows.map((row) => toIntentDto(
    row.intent,
    row.token,
    row.intent.recipientUserId ? recipientDto(row.recipientAddress, row.recipientName) : null,
    prices,
  )));
}

export async function cancelIntent(senderId: string, intentId: string, ipHash: string): Promise<IntentDto> {
  const joined = await db.transaction(async (tx) => {
    await lockPhoneMutation(tx);
    const now = new Date();
    const [cancelled] = await tx.update(intents).set({ status: 'cancelled' })
      .where(and(
        eq(intents.id, intentId),
        eq(intents.senderUserId, senderId),
        inArray(intents.status, [...OPEN_STATUSES]),
        gt(intents.expiresAt, now),
      )).returning({ id: intents.id });
    if (!cancelled) throw errors.intentNotOpen();

    const [row] = await tx.select({
      intent: intents,
      token: tokens,
      recipientAddress: users.address,
      recipientName: users.displayName,
    }).from(intents)
      .innerJoin(tokens, eq(tokens.address, intents.tokenAddress))
      .leftJoin(users, eq(users.id, intents.recipientUserId))
      .where(eq(intents.id, cancelled.id)).limit(1);
    if (!row) throw new Error('Cancelled intent details are missing.');
    await audit('intent_cancelled', {
      userId: senderId,
      data: {
        intentId: row.intent.id,
        phoneMasked: row.intent.recipientPhoneMasked,
        symbol: row.token.symbol,
      },
      ipHash,
    }, tx);
    return row;
  });

  return toIntentDto(
    joined.intent,
    joined.token,
    joined.intent.recipientUserId ? recipientDto(joined.recipientAddress, joined.recipientName) : null,
  );
}

export async function listIncoming(recipientId: string): Promise<IncomingIntentDto[]> {
  const [recipient] = await db.select({ phoneHmac: users.phoneHmac }).from(users)
    .where(eq(users.id, recipientId)).limit(1);
  if (!recipient?.phoneHmac) return [];

  const now = new Date();
  const cutoff = new Date(now.getTime() - RECENT_COMPLETED_MS);
  const rows = await db.select({
    intent: intents,
    token: tokens,
    senderAddress: users.address,
    senderName: users.displayName,
  }).from(intents)
    .innerJoin(tokens, eq(tokens.address, intents.tokenAddress))
    .innerJoin(users, eq(users.id, intents.senderUserId))
    .where(and(
      eq(intents.recipientUserId, recipientId),
      eq(intents.recipientPhoneHmac, recipient.phoneHmac),
      or(
        and(eq(intents.status, 'ready'), gt(intents.expiresAt, now)),
        and(eq(intents.status, 'completed'), gt(intents.completedAt, cutoff)),
      ),
    ))
    .orderBy(desc(intents.createdAt), desc(intents.id))
    .limit(INTENT_LIST_LIMIT);
  if (!rows.length) return [];

  const prices = await getPrices();
  return Promise.all(rows.map(async (row) => ({
    id: row.intent.id,
    status: row.intent.status as 'ready' | 'completed',
    sender: {
      address: checksum(row.senderAddress),
      displayName: row.senderName || `${row.senderAddress.slice(0, 6)}…${row.senderAddress.slice(-4)}`,
    },
    token: await tokenDto(row.token, prices),
    amount: formatAmount(row.intent.amountRaw, row.token.decimals),
    note: row.intent.note,
    createdAt: row.intent.createdAt.toISOString(),
  })));
}

export async function getClaim(code: string): Promise<PublicClaimDto> {
  if (!BASE62_CODE.test(code)) throw errors.notFound();
  const [row] = await db.select({
    intent: intents,
    token: tokens,
    senderAddress: users.address,
    senderName: users.displayName,
  }).from(intents)
    .innerJoin(tokens, eq(tokens.address, intents.tokenAddress))
    .innerJoin(users, eq(users.id, intents.senderUserId))
    .where(eq(intents.code, code)).limit(1);
  if (!row) throw errors.notFound();

  const status = effectiveStatus(row.intent);
  return {
    status,
    senderDisplayName: row.senderName || `${row.senderAddress.slice(0, 6)}…${row.senderAddress.slice(-4)}`,
    token: {
      symbol: row.token.symbol,
      name: row.token.name,
      logoUrl: row.token.logoUrl,
      decimals: row.token.decimals,
    },
    amount: formatAmount(row.intent.amountRaw, row.token.decimals),
    note: row.intent.note,
    recipientPhoneMasked: row.intent.recipientPhoneMasked,
    expiresAt: row.intent.expiresAt.toISOString(),
  };
}
