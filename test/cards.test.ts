import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { advanceStatus, decimal, emailInput, invoiceUrl, iso, mayUpdateTransaction, normalizeCard, normalizeInvoice, normalizeTransaction, parseProviderJson, payCurrency, sanitizeEvent, signRequest, transactionUpdate, usdInput, verifyWebhook } from '../src/modules/cards/domain.js';

const issue = { card_id: 'card_test_123', issue_status: 'pending_payment', payment: { provider: 'izipay_gateway_sandbox',
  payment_id: 'gwtest_123', deposit_address: 'TEST-DEPOSIT-ADDRESS', pay_amount: '10.123456789012345678',
  pay_currency: 'usdtbsc', network: 'bsc', amount_usd: '10', expires_at: '2026-10-07T19:12:28+00:00' } };

describe('card provider boundaries', () => {
  it('signs the exact transmitted bytes and query, with refreshed timestamp signatures', () => {
    const path = '/api/v1/cards/issue', body = '{"cardholder_email":"user@example.com"}';
    const expected = createHmac('sha256', 'secret').update('1725465600\nPOST\n/api/v1/cards/issue\n' + body).digest('hex');
    expect(signRequest('secret', '1725465600', 'POST', path, body)).toBe(expected);
    expect(signRequest('secret', '1725465601', 'POST', path, body)).not.toBe(expected);
    expect(signRequest('secret', '1725465600', 'POST', path, body + ' ')).not.toBe(expected);
    expect(signRequest('secret', '1725465600', 'GET', '/api/v1/cards?limit=50', '')).not.toBe(signRequest('secret', '1725465600', 'GET', '/api/v1/cards', ''));
  });
  it('verifies HMAC over raw webhook bytes and rejects malformed encodings and changed whitespace', () => {
    const raw = Buffer.from('{"type":"card.issued"}');
    const sig = createHmac('sha256', 'webhook-secret').update(raw).digest('hex');
    expect(verifyWebhook('webhook-secret', raw, sig)).toBe(true);
    expect(verifyWebhook('api-secret', raw, sig)).toBe(false);
    expect(verifyWebhook('webhook-secret', Buffer.concat([raw, Buffer.from(' ')]), sig)).toBe(false);
    for (const invalid of [undefined, '', 'gg'.repeat(32), sig.slice(2), [sig]]) expect(verifyWebhook('webhook-secret', raw, invalid)).toBe(false);
  });
  it('preserves exact numeric money lexemes without altering JSON strings', () => {
    expect(parseProviderJson('{"amount":12345678901234567890.123456789012345678,"card":{"number":"4111111111111111"},"flag":true,"n":null}'))
      .toEqual({ amount: '12345678901234567890.123456789012345678', card: { number: '4111111111111111' }, flag: true, n: null });
    expect(decimal('0.000000000000000001')).toBe('0.000000000000000001');
    expect(decimal('1.0000000000000000001')).toBeNull();
    expect(decimal(9007199254740992)).toBeNull();
  });
  it('normalizes gross USD requests without floating point rounding and enforces bounds', () => {
    expect(usdInput('25')).toBe('25.00');
    expect(usdInput('0.01')).toBe('0.01');
    expect(usdInput('10000.00')).toBe('10000.00');
    for (const value of ['0', '-1', '1.001', '10000.01', '1e2', '01', 'NaN']) expect(() => usdInput(value)).toThrow();
  });
  it('normalizes only the email domain, preserving the local part', () => {
    expect(emailInput(' User.Name@EXAMPLE.COM ')).toBe('User.Name@example.com');
    expect(() => emailInput('not-an-email')).toThrow();
  });
  it('uses the sandbox-confirmed BSC currency code and exact invoice amount', () => {
    expect(payCurrency('bsc')).toBe('usdtbsc');
    expect(normalizeInvoice(issue, 'bsc')).toEqual({ paymentId: 'gwtest_123', address: 'TEST-DEPOSIT-ADDRESS', amount: '10.123456789012345678', payCurrency: 'usdtbsc', network: 'bsc', expiresAt: '2026-10-07T19:12:28.000Z', url: null, amountUsd: '10', amountOnCardUsd: null });
    expect(() => normalizeInvoice(issue, 'tron')).toThrow('Invoice network mismatch');
    expect(() => normalizeInvoice({ payment: { ...issue.payment, network: 'trc20' } }, 'bsc')).toThrow();
  });
  it('never invents payment instructions from a dedup response or a currency-free address', () => {
    expect(normalizeInvoice({ card_id: 'card_test_123', duplicate: true }, 'bsc').address).toBeNull();
    expect(normalizeInvoice({ payment: { deposit_address: 'TEST', pay_amount: '10' } }, 'bsc').amount).toBeNull();
  });
  it('only permits recognized provider HTTPS invoice URLs', () => {
    expect(invoiceUrl('https://nowpayments.io/payment?iid=123')).toBe('https://nowpayments.io/payment?iid=123');
    for (const url of ['javascript:alert(1)', 'https://evil.example/pay', 'https://izipay.me.evil.example/', 'https://user:secret@izipay.me/', 'https://izipay.me:444/', 'http://izipay.me/']) expect(invoiceUrl(url)).toBeNull();
  });
  it('strips full details from ordinary card normalization and parses provider UTC times', () => {
    const safe = normalizeCard({ card_id: 'card_test_123', issue_status: 'issued', issued_at: '2026-10-06 19:12:29', card: { number: '4111111111111111', cvv: '123', exp: '10/29', last4: '1111', balance: '0', pending_topup: '0', is_frozen: false }, cardholder_email: 'user@example.com' });
    expect(safe.last4).toBe('1111');
    expect(safe.balanceUsd).toBe('0');
    expect(safe.isFrozen).toBe(false);
    expect(safe.issuedAt).toBe('2026-10-06T19:12:29.000Z');
    expect(JSON.stringify(safe)).not.toMatch(/4111111111111111|cvv|exp|email/);
    expect(normalizeCard({ issue_status: 'issued' }).balanceUsd).toBeNull();
    expect(iso('invalid')).toBeNull();
  });
  it('sanitizes durable event payloads, including OTPs and malicious extra nested fields', () => {
    const safe = sanitizeEvent({ id: 'evt_123', type: 'card.otp', created: '1791300000', data: { card_id: 'card_123', code: '123456', card_number: '4111111111111111', cardholder_email: 'secret@example.com', card: { cvv: '123' } } });
    expect(safe.payload).toEqual({ card_id: 'card_123' });
    expect(JSON.stringify(safe)).not.toMatch(/123456|4111111111111111|email|cvv/);
  });
});

describe('card reconciliation', () => {
  it('does not regress completed or paid operations when late responses arrive', () => {
    expect(advanceStatus('completed', 'awaiting_payment')).toBe('completed');
    expect(advanceStatus('processing', 'awaiting_payment')).toBe('processing');
    expect(advanceStatus('processing', 'expired')).toBe('processing');
    expect(advanceStatus('review', 'completed')).toBe('completed');
    expect(advanceStatus('expired', 'processing')).toBe('processing');
  });
  it('normalizes actual uppercase sandbox transaction statuses without mixing credits with spending', () => {
    const row = normalizeTransaction({ id: 'SBX-123', amount: '22.55', currency: 'USD', type: 'topup', status: 'SUCCESS', is_credit: true, merchant: 'Test credit', date: '2026-10-06 19:14:19' });
    expect(row).toMatchObject({ providerTransactionId: 'SBX-123', amount: '22.55', status: 'success', type: 'topup', direction: 'credit', isFinal: true, billedUsd: null, occurredAt: '2026-10-06T19:14:19.000Z' });
    expect(normalizeTransaction({ type: 'purchase', amount: '-12.4', date: '2026-10-06 19:14:19' })).toBeNull();
  });
  it('does not regress settled transactions or ambiguous conflicting final states', () => {
    const settled = { status: 'success', isFinal: true, sourceUpdatedAt: new Date('2026-10-06T19:00:00Z') };
    expect(mayUpdateTransaction(settled, { ...settled, status: 'pending', isFinal: false })).toBe(false);
    expect(mayUpdateTransaction(settled, { ...settled, status: 'reversed', sourceUpdatedAt: null })).toBe(false);
    expect(mayUpdateTransaction(settled, { ...settled, sourceUpdatedAt: new Date('2026-10-06T18:00:00Z') })).toBe(false);
    expect(mayUpdateTransaction(settled, { ...settled, status: 'reversed', sourceUpdatedAt: new Date('2026-10-06T20:00:00Z') })).toBe(true);
    expect(mayUpdateTransaction(settled, settled)).toBe(true); // later same-status corrected amounts can update
  });
});

describe('transaction history and webhook ordering regressions', () => {
  it('advances timestamped pending webhooks from unversioned final history without allowing a downgrade', () => {
    const pending = { status: 'pending', isFinal: false, amount: '10', sourceUpdatedAt: new Date('2026-10-06T19:00:00Z') };
    const settled = transactionUpdate(pending, { ...pending, status: 'success', isFinal: true, amount: '12', sourceUpdatedAt: null });
    expect(settled).toEqual({ ...pending, status: 'success', isFinal: true, amount: '12' });
    expect(transactionUpdate(settled!, { ...pending, sourceUpdatedAt: new Date('2026-10-06T20:00:00Z') })).toBeNull();
    expect(transactionUpdate(pending, { ...pending, status: 'success', isFinal: true, sourceUpdatedAt: new Date('2026-10-06T18:00:00Z') })).toBeNull();
  });
  it('retains the newest known source timestamp across unversioned history corrections', () => {
    const finalWebhook = { status: 'success', isFinal: true, amount: '10', sourceUpdatedAt: new Date('2026-10-06T19:00:00Z') };
    const correctedHistory = transactionUpdate(finalWebhook, { ...finalWebhook, amount: '12', sourceUpdatedAt: null });
    expect(correctedHistory?.amount).toBe('12');
    expect(correctedHistory?.sourceUpdatedAt).toEqual(finalWebhook.sourceUpdatedAt);
    const oldCallback = { ...finalWebhook, amount: '9', sourceUpdatedAt: new Date('2026-10-06T18:00:00Z') };
    expect(transactionUpdate(correctedHistory!, oldCallback)).toBeNull();
    expect(transactionUpdate(correctedHistory!, { ...finalWebhook, amount: '13', sourceUpdatedAt: new Date('2026-10-06T20:00:00Z') }))
      .toMatchObject({ amount: '13', sourceUpdatedAt: new Date('2026-10-06T20:00:00Z') });
  });
  it('keeps conflicting unversioned final states unresolved', () => {
    const settled = { status: 'success', isFinal: true, sourceUpdatedAt: new Date('2026-10-06T19:00:00Z') };
    expect(transactionUpdate(settled, { ...settled, status: 'reversed', sourceUpdatedAt: null })).toBeNull();
  });
});
