import { config } from '../../config.js';
import { redis } from '../../lib/redis.js';
import { hash, identifier, parseProviderJson, record, signRequest } from './domain.js';
import { providerScope, requireCards } from './settings.js';

export class ProviderError extends Error {
  constructor(public readonly outcome: 'not_sent' | 'rejected' | 'unknown', public readonly reason: 'rate' | 'validation' | 'unavailable' | 'invalid_response' = 'unavailable') {
    super(`Card provider ${reason}`);
  }
}
const origin = 'https://izipay.me';
const prefix = '/api/v1';
export const providerRedisPrefix = `cards:provider:${providerScope}`;
const rateScript = `
local blocked = redis.call('EXISTS', KEYS[2])
if blocked == 1 then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
local limit = tonumber(redis.call('GET', KEYS[3]) or '24')
if redis.call('ZCARD', KEYS[1]) >= limit then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], 61000)
return 1`;

async function request(method: 'GET' | 'POST', path: string, body = '', idempotencyKey?: string): Promise<unknown> {
  requireCards();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signRequest(config.IZIPAY_API_SECRET, timestamp, method, prefix + path, body);
  try {
    const allowed = await redis.eval(rateScript, 3, `${providerRedisPrefix}:budget`, `${providerRedisPrefix}:cooldown`, `${providerRedisPrefix}:limit`, crypto.randomUUID());
    if (allowed !== 1) throw new ProviderError('not_sent', 'rate');
    // Replay protection is shared by API and worker, including concurrent reveals.
    if (!await redis.set(`${providerRedisPrefix}:signature:${hash(signature)}`, '1', 'EX', 305, 'NX')) throw new ProviderError('not_sent', 'rate');
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('not_sent');
  }
  try {
    const response = await fetch(origin + prefix + path, {
      method, body: method === 'POST' ? body : undefined,
      headers: { authorization: `Bearer ${config.IZIPAY_API_KEY}`, 'content-type': 'application/json',
        'x-timestamp': timestamp, 'x-signature': signature, ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}) },
      signal: AbortSignal.timeout(12_000), redirect: 'error',
    });
    if (response.status === 429) {
      await response.body?.cancel();
      await redis.set(`${providerRedisPrefix}:cooldown`, '1', 'EX', 60).catch(() => {});
      // An HTTP response to a mutation does not establish whether work was accepted.
      throw new ProviderError('unknown', 'rate');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError([400, 401, 403, 404, 422].includes(response.status) ? 'rejected' : 'unknown', response.status === 400 || response.status === 422 ? 'validation' : 'unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError('unknown', 'invalid_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new ProviderError('unknown', 'invalid_response'); }
      chunks.push(part.value);
    }
    const envelope = record(parseProviderJson(Buffer.concat(chunks).toString('utf8')));
    if (envelope.success !== true || !('data' in envelope)) throw new ProviderError('unknown', 'invalid_response');
    return envelope.data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Never include fetch causes, raw response text, request bytes or secrets in errors.
    throw new ProviderError('unknown');
  }
}
function cardPath(id: string) {
  if (!identifier(id)) throw new ProviderError('not_sent', 'invalid_response');
  return `/cards/${id}`;
}
export const provider = {
  issue: (rawBody: string, key: string) => request('POST', '/cards/issue', rawBody, key),
  topup: (id: string, rawBody: string, key: string) => request('POST', `${cardPath(id)}/topup`, rawBody, key),
  card: (id: string, live = false) => request('GET', cardPath(id) + (live ? '?live=1' : '')),
  cards: (page: number) => request('GET', `/cards?page=${page}&limit=100`),
  transactions: (id: string, offset: number) => request('GET', `${cardPath(id)}/transactions?limit=100&offset=${offset}`),
  pricing: () => request('GET', '/balance'),
  // Apple Pay Mastercard: arm for a wallet-provisioning code, then poll for it.
  armApplePay: (id: string) => request('POST', `${cardPath(id)}/apple-pay-code`),
  applePayCode: (id: string) => request('GET', `${cardPath(id)}/apple-pay-code`),
};
