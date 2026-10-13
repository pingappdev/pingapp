import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { checkBatch, checkRequest } from '../src/modules/rpc/policy.js';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), consume: vi.fn(), settings: {
    RPC_RELAY_ENABLED: true, RPC_RELAY_MAX_BATCH: 20, RPC_RELAY_MAX_BODY_BYTES: 65536,
    ALCHEMY_API_KEYS: ['provider-secret'], IP_HASH_SALT: 'test-ip-salt',
  },
}));
vi.mock('../src/config.js', () => ({ config: mocks.settings, allowedOrigins: ['http://localhost:7400'] }));
vi.mock('../src/plugins/auth.js', () => ({ readSessionToken: () => null }));
vi.mock('../src/lib/rateLimit.js', () => ({
  limiter: (name: string, points: number, duration: number) => ({ name, points, duration }),
  consume: mocks.consume,
  limits: { general: { name: 'general', points: 120, duration: 60 } },
}));
vi.mock('../src/lib/rpcPool.js', () => ({
  rpc: mocks.rpc,
  RpcError: class extends Error {
    constructor(public code: number, message: string, public data?: unknown) { super(message); }
  },
}));
import routes from '../src/modules/rpc/routes.js';
import { RpcError } from '../src/lib/rpcPool.js';
import security from '../src/plugins/security.js';

const entry = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0', id: 1, method, params });

describe('RPC relay policy', () => {
  it.each([
    'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode',
    'eth_getStorageAt', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
    'eth_feeHistory', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  ])('allows %s', (method) => expect(checkRequest(entry(method))).toEqual({ ok: true }));

  it.each(['eth_accounts', 'debug_traceTransaction', 'admin_peers', 'eth_sendTransaction', 'personal_sign'])
    ('denies %s', (method) => expect(checkRequest(entry(method))).toMatchObject({ code: -32601 }));

  it.each([null, [], {}, { jsonrpc: '1.0', method: 'eth_chainId' },
    { jsonrpc: '2.0', method: 'eth_chainId', params: {} },
    { jsonrpc: '2.0', method: 'eth_chainId', id: {} }])
    ('rejects malformed entries %j', (value) => expect(checkRequest(value)).toMatchObject({ code: -32600 }));

  it('allows exactly 10000 log blocks and denies the next block', () => {
    expect(checkRequest(entry('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x270f' }]))).toEqual({ ok: true });
    expect(checkRequest(entry('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x2710' }]))).toMatchObject({ code: -32602 });
    expect(checkRequest(entry('eth_getLogs', [{ fromBlock: 20, toBlock: 25 }]))).toEqual({ ok: true });
  });

  it.each([
    { fromBlock: 'earliest', toBlock: '0x10' }, { fromBlock: '0x1', toBlock: 'latest' },
    { fromBlock: 'pending', toBlock: 'pending' }, {}, { fromBlock: 10, toBlock: 9 },
    { fromBlock: -1, toBlock: 2 }, { fromBlock: 0.5, toBlock: 2 },
  ])('rejects unsafe log filters %j', (filter) => {
    expect(checkRequest(entry('eth_getLogs', [filter]))).toMatchObject({ code: -32602 });
  });

  it('allows a single blockHash without range tags', () => {
    const blockHash = `0x${'ab'.repeat(32)}`;
    expect(checkRequest(entry('eth_getLogs', [{ blockHash }]))).toEqual({ ok: true });
    expect(checkRequest(entry('eth_getLogs', [{ blockHash, fromBlock: 'earliest' }]))).toMatchObject({ code: -32602 });
    expect(checkRequest(entry('eth_getLogs', [{ blockHash: '0x1234' }]))).toMatchObject({ code: -32602 });
  });

  it('requires explicit false for full transactions', () => {
    expect(checkRequest(entry('eth_getBlockByNumber', ['latest', false]))).toEqual({ ok: true });
    for (const value of [true, 'false', undefined]) {
      expect(checkRequest(entry('eth_getBlockByNumber', ['latest', value]))).toMatchObject({ code: -32602 });
    }
  });

  it('enforces the batch cap and rejects empty batches', () => {
    expect(checkBatch(Array(20).fill(null), { maxBatch: 20 })).toEqual({ ok: true });
    expect(checkBatch(Array(21).fill(null), { maxBatch: 20 })).toMatchObject({ code: -32602 });
    expect(checkBatch([], { maxBatch: 20 })).toMatchObject({ code: -32600 });
  });

  it.each(['data', 'input'])('caps eth_call %s at 32 KiB and validates hex bytes', (field) => {
    expect(checkRequest(entry('eth_call', [{ [field]: `0x${'ab'.repeat(32768)}` }, 'latest']))).toEqual({ ok: true });
    expect(checkRequest(entry('eth_call', [{ [field]: `0x${'ab'.repeat(32769)}` }, 'latest']))).toMatchObject({ code: -32602 });
    expect(checkRequest(entry('eth_call', [{ [field]: '0xabc' }]))).toMatchObject({ code: -32602 });
  });

  it('rejects empty raw transaction bytes locally', () => {
    expect(checkRequest(entry('eth_sendRawTransaction', ['0x']))).toMatchObject({ code: -32602 });
    expect(checkRequest(entry('eth_sendRawTransaction', ['0x01']))).toEqual({ ok: true });
  });
});

beforeEach(() => {
  mocks.rpc.mockReset().mockResolvedValue('0x1237');
  mocks.consume.mockReset().mockResolvedValue(undefined);
  mocks.settings.RPC_RELAY_ENABLED = true;
});

async function withApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>, sessionId?: string) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.ipHash = 'hashed-ip';
    request.session = sessionId ? { id: sessionId, freshUntil: null } : null;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code } });
    return reply.code(500).send({ error: { code: 'INTERNAL' } });
  });
  await app.register(routes, { prefix: '/v1' });
  try { await run(app); } finally { await app.close(); }
}

describe('RPC relay forwarding (mocked pool and limiter)', () => {
  it('preserves mixed batch ids and excludes denied calls from forwarding', async () => withApp(async (app) => {
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', payload: [
      { ...entry('eth_chainId'), id: 'chain' }, { ...entry('debug_traceTransaction'), id: 7 }, entry('eth_blockNumber'),
    ] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { jsonrpc: '2.0', id: 'chain', result: '0x1237' },
      { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'method not allowed' } },
      { jsonrpc: '2.0', id: 1, result: '0x1237' },
    ]);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ name: 'rpc_ip', points: 300 }), 'ip:hashed-ip', 3);
  }));

  it('keys authenticated budgets by verified session id', async () => withApp(async (app) => {
    await app.inject({ method: 'POST', url: '/v1/rpc', payload: entry('eth_chainId') });
    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ name: 'rpc_session', points: 600 }), 'session:s1', 1);
  }, 's1'));

  it('does not forward a batch above the cap', async () => withApp(async (app) => {
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', payload: Array(21).fill(entry('eth_chainId')) });
    expect(response.json()[0].error.code).toBe(-32602);
    expect(mocks.rpc).not.toHaveBeenCalled();
  }));

  it('preserves node revert code and bytes while withholding URLs, keys and stack diagnostics', async () => withApp(async (app) => {
    mocks.rpc.mockRejectedValue(new RpcError(3, 'execution reverted https://node.invalid/provider-secret',
      { data: '0x08c379a0', stack: 'private stack', diagnostic: 'provider-secret' }));
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', payload: entry('eth_call', [{ data: '0x' }]) });
    expect(response.json().error).toEqual({ code: 3, message: 'execution reverted [redacted]',
      data: { data: '0x08c379a0', diagnostic: '[redacted]' } });
    expect(response.body).not.toContain('provider-secret');
  }));

  it('returns a generic error for transport failures', async () => withApp(async (app) => {
    mocks.rpc.mockRejectedValue(new Error('https://node.invalid/provider-secret'));
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', payload: entry('eth_chainId') });
    expect(response.json().error).toEqual({ code: -32603, message: 'upstream unavailable' });
  }));

  it('drops sensitive error-data property names recursively while preserving revert bytes', async () => withApp(async (app) => {
    mocks.rpc.mockRejectedValue(new RpcError(3, 'execution reverted', {
      data: '0x769cabf1', 'https://node.invalid/provider-secret': 'diagnostic',
      nested: [{ 'prefix-provider-secret-suffix': 'private', data: '0x08c379a0',
        inner: { 'wss://node.invalid/socket': 'private', reason: 'known revert' } }],
    }));
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', payload: entry('eth_call', [{ data: '0x' }]) });
    expect(response.json().error.data).toEqual({ data: '0x769cabf1',
      nested: [{ data: '0x08c379a0', inner: { reason: 'known revert' } }] });
    expect(response.body).not.toContain('provider-secret');
    expect(response.body).not.toContain('node.invalid');
  }));

  it('enforces raw transaction budget before forwarding any entry', async () => withApp(async (app) => {
    mocks.consume.mockImplementation(async (limit: { name: string }, _key: string, points: number) => {
      if (limit.name === 'rpc_raw_tx' && points > 30) throw new AppError('RATE_LIMITED', 429, 'rate limited');
    });
    // Raise only the batch cap for this isolated limiter unit check.
    mocks.settings.RPC_RELAY_MAX_BATCH = 40;
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/rpc', payload: Array(31).fill(entry('eth_sendRawTransaction', ['0x'])) });
      expect(response.statusCode).toBe(429);
      expect(mocks.rpc).not.toHaveBeenCalled();
    } finally { mocks.settings.RPC_RELAY_MAX_BATCH = 20; }
  }));

  it('counts malformed raw bytes without forwarding them', async () => withApp(async (app) => {
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', payload: entry('eth_sendRawTransaction', ['0x']) });
    expect(response.json().error.code).toBe(-32602);
    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ name: 'rpc_raw_tx', points: 30 }), 'ip:hashed-ip', 1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  }));

  it('rejects malformed JSON and oversized bodies in the HTTP error envelope', async () => withApp(async (app) => {
    for (const [payload, status] of [['{', 400], [JSON.stringify({ padding: 'x'.repeat(65536) }), 413]] as const) {
      const response = await app.inject({ method: 'POST', url: '/v1/rpc', headers: { 'content-type': 'application/json' }, payload });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe('VALIDATION');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  }));

  it('supports disabling the relay without touching the pool', async () => withApp(async (app) => {
    mocks.settings.RPC_RELAY_ENABLED = false;
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', payload: entry('eth_chainId') });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('RPC_RELAY_DISABLED');
    expect(mocks.rpc).not.toHaveBeenCalled();
  }));
});

describe('RPC early security guard', () => {
  async function withSecurity(run: (app: ReturnType<typeof Fastify>, authCalls: () => number) => Promise<void>) {
    const app = Fastify();
    let authenticated = 0;
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code } });
      return reply.code(500).send({ error: { code: 'INTERNAL' } });
    });
    // This is the production ordering: security's onRequest hook is before auth.
    await app.register(security);
    app.addHook('onRequest', async (request) => {
      authenticated++;
      request.session = { id: 'verified-session', freshUntil: null };
    });
    await app.register(routes, { prefix: '/v1' });
    try { await run(app, () => authenticated); } finally { await app.close(); }
  }

  const headers = { origin: 'http://localhost:7400', 'x-pingapp': '1',
    'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(43)}` };

  it('charges every malformed/oversize body before the authentication hook', async () => withSecurity(async (app, authCalls) => {
    mocks.consume.mockImplementation(async (limit: { name: string }) => {
      if (limit.name === 'rpc_request_ip') expect(mocks.consume.mock.calls.length).toBe(authCalls() + 1);
    });
    // Repeat the reviewer's malformed-input reproduction without a DB or pool.
    for (let i = 0; i < 301; i++) {
      const response = await app.inject({ method: 'POST', url: '/v1/rpc', headers, payload: '{' });
      expect(response.statusCode).toBe(400);
    }
    const oversized = await app.inject({ method: 'POST', url: '/v1/rpc', headers,
      payload: JSON.stringify({ padding: 'x'.repeat(65536) }) });
    expect(oversized.statusCode).toBe(413);
    expect(authCalls()).toBe(302);
    expect(mocks.consume).toHaveBeenCalledTimes(302);
    for (const [limit, key, points] of mocks.consume.mock.calls) {
      expect(limit).toEqual({ name: 'rpc_request_ip', points: 600, duration: 60 });
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      expect(points).toBeUndefined();
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  }));

  it('blocks an exhausted early request budget before authentication and parsing', async () => withSecurity(async (app, authCalls) => {
    mocks.consume.mockRejectedValue(new AppError('RATE_LIMITED', 429, 'rate limited'));
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', headers, payload: '{' });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('RATE_LIMITED');
    expect(authCalls()).toBe(0);
    expect(mocks.consume).toHaveBeenCalledOnce();
    expect(mocks.rpc).not.toHaveBeenCalled();
  }));

  it('keeps the early request guard separate from verified-session per-entry budgets', async () => withSecurity(async (app) => {
    const response = await app.inject({ method: 'POST', url: '/v1/rpc', headers,
      payload: [entry('eth_chainId'), entry('eth_blockNumber'), entry('net_version')] });
    expect(response.statusCode).toBe(200);
    expect(mocks.consume.mock.calls[0]).toEqual([
      { name: 'rpc_request_ip', points: 600, duration: 60 }, expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(mocks.consume.mock.calls[1]).toEqual([
      { name: 'rpc_session', points: 600, duration: 60 }, 'session:verified-session', 3,
    ]);
  }));
});
