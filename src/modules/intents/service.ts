import { and, desc, eq, gt, inArray, or } from 'drizzle-orm';
import { config } from '../../config.js';
import { audit } from '../../db/audit.js';
import { db } from '../../db/client.js';
import { intents, tokens, users, type Intent, type Token } from '../../db/schema.js';
import { checksum } from '../../lib/chain.js';
import { AppError, errors } from '../../lib/errors.js';
import { formatAmount } from '../../lib/money.js';
import { getMinAmountRaw } from '../tokens/minimum.js';
import { getPrices } from '../tokens/prices.js';
import { toTokenDto, type TokenDto } from '../tokens/routes.js';
import { lockPhoneMutation } from '../phone/lock.js';
import { getEscrowClaim } from '../escrows/public.js';

const OPEN_STATUSES = ['pending', 'ready'] as const;
const BASE62_CODE = /^[0-9A-Za-z]{10}$/;
const INTENT_LIST_LIMIT = 100;
const RECENT_COMPLETED_MS = 30 * 24 * 60 * 60 * 1000;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

export type CreateIntentInput = {
  phone: string;
  tokenAddress: string;
  amount: string;
  note?: string;
};

export type IntentRecipient = { displayName: string };

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

export function cleanNote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const note = value.trim().replace(CONTROL_CHARACTERS, '').trim();
  if ([...note].length > 140) {
    throw errors.validation('Notes must be 140 characters or fewer.');
  }
  return note || null;
}

export function smsName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9 .'_-]/g, '').slice(0, 20).trim();
  return safe || 'A PingApp user';
}

export function smsAmount(value: string): string {
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

function recipientDto(name: string | null): IntentRecipient {
  return { displayName: name || 'PingApp recipient' };
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
    readyAt: null,
    completedAt: intent.completedAt?.toISOString() ?? null,
  };
}

export async function createIntent(
  _senderId: string,
  _input: CreateIntentInput,
  _ipHash: string,
): Promise<IntentDto> {
  throw new AppError('USE_ESCROW', 409, 'Use Send to make a payment. New pending sends are no longer available.');
}

export async function listIntents(senderId: string, status: 'open' | 'all' = 'open'): Promise<IntentDto[]> {
  const now = new Date();
  const rows = await db.select({
    intent: intents,
    token: tokens,
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
    row.intent.recipientUserId ? recipientDto(row.recipientName) : null,
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
    joined.intent.recipientUserId ? recipientDto(joined.recipientName) : null,
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

export async function getClaim(code: string): Promise<PublicClaimDto | NonNullable<Awaited<ReturnType<typeof getEscrowClaim>>>> {
  if (!BASE62_CODE.test(code)) throw errors.notFound();
  const escrow = await getEscrowClaim(code);
  if (escrow) return escrow;
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
