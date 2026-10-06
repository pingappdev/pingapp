import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';

export const networks = [
  { id: 'tron', label: 'TRON', payCurrency: 'usdttrc20' },
  { id: 'bsc', label: 'BNB Smart Chain', payCurrency: 'usdtbsc' },
  { id: 'ethereum', label: 'Ethereum', payCurrency: 'usdterc20' },
  { id: 'polygon', label: 'Polygon', payCurrency: 'usdtpoly' },
] as const;
export const networkSchema = z.enum(['tron', 'bsc', 'ethereum', 'polygon']);
export type CardNetwork = z.infer<typeof networkSchema>;
export type OperationStatus = 'created' | 'submitting' | 'awaiting_payment' | 'processing' | 'completed' | 'failed' | 'expired' | 'review';
export const payCurrency = (network: CardNetwork) => networks.find((item) => item.id === network)!.payCurrency;
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown, max = 256): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
export const identifier = (value: unknown): string | null => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : string(value, 128);
  return text && /^[A-Za-z0-9_-]+$/.test(text) ? text : null;
};
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function decimal(value: unknown, signed = false): string | null {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !(signed ? /^-?\d{1,20}(\.\d{1,18})?$/ : /^\d{1,20}(\.\d{1,18})?$/).test(text)) return null;
  const [integer, fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return integer.replace(/^(-?)0+(?=\d)/, '$1') + (trimmed ? `.${trimmed}` : '');
}
export function usdInput(value: string): string {
  if (!/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value)) throw new Error('Invalid amount');
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > 1_000_000n) throw new Error('Invalid amount');
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
export function requireExpectedAccount(userId: string, expectedUserId: string): void {
  if (userId.toLowerCase() !== expectedUserId.toLowerCase()) {
    throw new AppError('ACCOUNT_CHANGED', 409, 'Your signed-in account changed. Return to the account that opened this card form and try again.');
  }
}
export function emailInput(value: string): string {
  const email = z.email().max(254).parse(value.trim());
  const at = email.lastIndexOf('@');
  return email.slice(0, at + 1) + email.slice(at + 1).toLowerCase();
}
export function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return null;
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function signRequest(secret: string, timestamp: string, method: string, path: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${method}\n${path}\n${body}`).digest('hex');
}
export function verifyWebhook(secret: string, body: Buffer, signature: unknown): boolean {
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
// Preserve JSON number lexemes so invoice quantities never round through IEEE754.
export function parseProviderJson(raw: string): unknown {
  return JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token) => token.startsWith('"') ? token : JSON.stringify(token)));
}
export function invoiceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      ['izipay.me', 'nowpayments.io'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
export function normalizeInvoice(data: unknown, network: CardNetwork) {
  const root = record(data);
  const payment = Object.keys(record(root.payment)).length ? record(root.payment) : root;
  const currency = string(payment.pay_currency);
  const providerNetwork = string(payment.network);
  const aliases: Record<CardNetwork, string[]> = {
    tron: ['tron', 'trc20'], bsc: ['bsc', 'bep20'], ethereum: ['ethereum', 'eth', 'erc20'], polygon: ['polygon', 'poly'],
  };
  if (currency && currency.toLowerCase() !== payCurrency(network) || providerNetwork && !aliases[network].includes(providerNetwork.toLowerCase())) {
    throw new Error('Invoice network mismatch');
  }
  // Missing currency cannot establish that an address is safe for the requested chain.
  const address = currency ? string(payment.deposit_address ?? payment.pay_address, 256) : null;
  return {
    paymentId: identifier(payment.payment_id ?? root.payment_id),
    address,
    amount: currency ? decimal(payment.pay_amount) : null,
    payCurrency: payCurrency(network), network,
    expiresAt: iso(payment.expires_at),
    url: currency ? invoiceUrl(payment.invoice_url) : null,
    amountUsd: decimal(payment.amount_usd ?? root.amount_usd),
    amountOnCardUsd: decimal(root.amount_on_card ?? payment.amount_on_card),
  };
}
export function normalizeCard(value: unknown) {
  const data = record(value), card = record(data.card);
  const issue = string(data.issue_status);
  const issueStatus = issue === 'issued' ? 'issued' : issue === 'failed' ? 'failed' :
    issue === 'pending_payment' ? 'pending_payment' : issue === 'paid_pending_issue' ? 'paid_pending_issue' : 'unknown';
  const last4 = string(card.last4 ?? data.last4);
  const frozen = card.is_frozen ?? data.is_frozen;
  return {
    providerCardId: identifier(data.card_id), clientCardRef: identifier(data.client_card_ref), issueStatus,
    last4: last4 && /^\d{4}$/.test(last4) ? last4 : null,
    isFrozen: typeof frozen === 'boolean' ? frozen : frozen === '1' ? true : frozen === '0' ? false : null,
    balanceUsd: decimal(card.balance ?? data.balance), pendingTopupUsd: decimal(card.pending_topup ?? data.pending_topup),
    issuedAt: iso(data.issued_at), balanceSource: data.balance_source === 'live' ? 'live' : 'provider',
  };
}
export function issueOperationStatus(issue: string): OperationStatus {
  return issue === 'issued' ? 'completed' : issue === 'failed' ? 'failed' :
    issue === 'paid_pending_issue' ? 'processing' : issue === 'pending_payment' ? 'awaiting_payment' : 'review';
}
// Final card/credit evidence wins over late HTTP responses and old pending callbacks.
export function advanceStatus(current: string, incoming: OperationStatus): OperationStatus {
  if (current === 'completed') return 'completed';
  if (incoming === 'completed') return incoming;
  if (current === 'processing' && ['created', 'submitting', 'awaiting_payment', 'expired'].includes(incoming)) return 'processing';
  if (current === 'failed' && incoming !== 'processing') return 'failed';
  return incoming;
}
export function normalizeTransaction(value: unknown) {
  const data = record(value);
  const providerTransactionId = identifier(data.transaction_id ?? data.id);
  const amount = decimal(data.amount, true);
  const occurredAt = iso(data.occurred_at ?? data.date ?? data.created_at);
  const currency = string(data.currency, 8);
  if (!providerTransactionId || amount === null || !occurredAt || !currency || !/^[A-Z]{3,8}$/.test(currency)) return null;
  const rawType = string(data.type)?.toLowerCase();
  const type = rawType && ['purchase', 'refund', 'topup', 'fee', 'withdrawal', 'reversal', 'authorization'].includes(rawType) ? rawType : 'other';
  const rawStatus = string(data.status)?.toLowerCase();
  const status = rawStatus && ['pending', 'success', 'failed', 'reversed', 'settled', 'completed', 'declined'].includes(rawStatus) ? rawStatus : 'unknown';
  return {
    providerTransactionId, type, status, amount: amount.replace(/^-/, ''), currency,
    billedUsd: decimal(data.billed_usd, true), merchant: string(data.merchant, 200),
    direction: (typeof data.is_credit === 'boolean' ? data.is_credit ? 'credit' : 'debit' : ['refund', 'topup', 'reversal'].includes(type) ? 'credit' : 'debit') as 'credit' | 'debit',
    occurredAt, sourceUpdatedAt: iso(data.updated_at),
    isFinal: ['success', 'failed', 'reversed', 'settled', 'completed', 'declined'].includes(status),
  };
}
export function sanitizeEvent(value: unknown) {
  const root = record(value), data = record(root.data);
  const eventId = identifier(root.id), type = string(root.type, 80);
  if (!eventId || !type || !/^[a-z][a-z0-9_.]+$/.test(type)) throw new Error('Invalid event');
  const timestamp = typeof root.created === 'string' || typeof root.created === 'number' ? Number(root.created) : NaN;
  const eventAt = Number.isFinite(timestamp) && timestamp > 0 && timestamp < 100_000_000_000 ? new Date(timestamp * 1000).toISOString() : null;
  const payload: Record<string, unknown> = {};
  for (const key of ['card_id', 'client_card_ref', 'payment_id', 'topup_id', 'transaction_id']) {
    const id = identifier(data[key]);
    if (id) payload[key] = id;
  }
  // Never persist original objects: details, email and OTPs are not part of this allowlist.
  if (type === 'card.transaction') payload.transaction = normalizeTransaction(data);
  return { eventId, type, eventAt, payload };
}

export function mayUpdateTransaction(existing: { isFinal: boolean; status: string; sourceUpdatedAt: Date | null }, incoming: { isFinal: boolean; status: string; sourceUpdatedAt: Date | null }): boolean {
  if (existing.isFinal && !incoming.isFinal) return false;
  if (existing.sourceUpdatedAt && incoming.sourceUpdatedAt && incoming.sourceUpdatedAt < existing.sourceUpdatedAt) return false;
  // Conflicting final states without source ordering are ambiguous; leave history incomplete.
  if (existing.isFinal && incoming.isFinal && existing.status !== incoming.status &&
      (!incoming.sourceUpdatedAt || !existing.sourceUpdatedAt || incoming.sourceUpdatedAt <= existing.sourceUpdatedAt)) return false;
  if (existing.sourceUpdatedAt && !incoming.sourceUpdatedAt && existing.status !== incoming.status) return false;
  return true;
}
