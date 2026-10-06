import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ eval: vi.fn(), set: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: {
  CARDS_ENABLED: true, IZIPAY_API_KEY: 'izpk_test_placeholder', IZIPAY_API_SECRET: 'unit-test-placeholder',
  CARD_DATA_ENC_KEY: '11'.repeat(32), IZIPAY_MODE: 'sandbox', IZIPAY_ACCOUNT_REF: 'unit-test',
} }));
vi.mock('../src/lib/redis.js', () => ({ redis: { eval: mocks.eval, set: mocks.set } }));
import { provider, ProviderError } from '../src/modules/cards/provider.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.eval.mockResolvedValue(1);
  mocks.set.mockResolvedValue('OK');
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('provider transport safety', () => {
  it('sends precisely the signed bytes to the fixed host without following redirects', async () => {
    mocks.fetch.mockResolvedValue(new Response('{"success":true,"data":{"pay_amount":0.000000000000000001}}'));
    const body = '{"amount_usd":25.00,"pay_currency":"usdttrc20"}';
    expect(await provider.topup('card_123', body, 'durable-key')).toEqual({ pay_amount: '0.000000000000000001' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://izipay.me/api/v1/cards/card_123/topup');
    expect(init.body).toBe(body);
    expect(init.headers['x-idempotency-key']).toBe('durable-key');
    expect(init.headers['x-signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('never retries a top-up after a lost response', async () => {
    mocks.fetch.mockRejectedValue(new Error('Raw network cause containing sensitive request context'));
    const error = await provider.topup('card_123', '{}', 'durable-key').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ outcome: 'unknown' });
    expect(String(error)).not.toContain('sensitive');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('never retries after a provider timeout, rate response or malformed accepted response', async () => {
    for (const response of [new Response('upstream secret', { status: 503 }), new Response('raw limit details', { status: 429 }), new Response('not JSON')]) {
      mocks.fetch.mockResolvedValueOnce(response);
      await expect(provider.topup('card_123', '{}', 'durable-key')).rejects.toMatchObject({ outcome: 'unknown' });
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
  it('distinguishes a known local budget refusal from an already dispatched call', async () => {
    mocks.eval.mockResolvedValue(0);
    await expect(provider.topup('card_123', '{}', 'durable-key')).rejects.toMatchObject({ outcome: 'not_sent', reason: 'rate' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('prevents second-resolution signature replay and signs later reads afresh', async () => {
    mocks.set.mockResolvedValueOnce(null);
    await expect(provider.card('card_123')).rejects.toMatchObject({ outcome: 'not_sent' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockImplementation(() => Promise.resolve(new Response('{"success":true,"data":{}}')));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await provider.card('card_123');
    now.mockReturnValue(1_800_000_001_000);
    await provider.card('card_123');
    expect(mocks.fetch.mock.calls[0][1].headers['x-signature']).not.toBe(mocks.fetch.mock.calls[1][1].headers['x-signature']);
  });
  it('rejects provider IDs that could change the signed host or path', async () => {
    await expect(async () => provider.card('../payments/secret')).rejects.toMatchObject({ outcome: 'not_sent' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('strips provider validation details from errors', async () => {
    mocks.fetch.mockResolvedValue(new Response('{"email":"private@example.com","cvv":"123"}', { status: 400 }));
    const error = await provider.issue('{}', 'durable-key').catch((error: unknown) => error);
    expect(error).toMatchObject({ outcome: 'rejected', reason: 'validation' });
    expect(String(error)).not.toMatch(/private|cvv/);
  });
});

import { decryptCardData, encryptCardData } from '../src/modules/cards/settings.js';
describe('card encryption context', () => {
  it('encrypts card email and binds it to its owner or immutable operation', () => {
    const value = encryptCardData('user@example.com', 'profile:owner-one');
    expect(value).not.toContain('user@example.com');
    expect(decryptCardData(value, 'profile:owner-one')).toBe('user@example.com');
    expect(() => decryptCardData(value, 'profile:owner-two')).toThrow();
    expect(() => decryptCardData(value, 'operation:owner-one')).toThrow();
  });
  it('rejects modified ciphertext', () => {
    const encrypted = encryptCardData('{"email":"user@example.com"}', 'operation:123');
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() => decryptCardData(bytes.toString('base64'), 'operation:123')).toThrow();
  });
});
