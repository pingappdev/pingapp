import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { createRpcPool, RpcError } from '../src/lib/rpcPool.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('RPC pool', () => {
  it('rotates round-robin over Alchemy endpoints and sends the required User-Agent', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      expect(new Headers(init?.headers).get('user-agent')).toBe('PingApp/1.0');
      const request = JSON.parse(String(init?.body)) as { method: string };
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: request.method });
    }));
    const pool = createRpcPool({ alchemyUrls: ['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key'], publicUrl: 'https://rpc.invalid' });

    await expect(pool.rpc('eth_chainId', [])).resolves.toBe('eth_chainId');
    await expect(pool.rpc('eth_blockNumber', [])).resolves.toBe('eth_blockNumber');
    expect(seen).toEqual(['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key']);
  });

  it('cools an endpoint after HTTP 429 and retries on the next endpoint', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (seen.length === 1) return jsonResponse({}, 429);
      return jsonResponse({ jsonrpc: '2.0', id: 2, result: '0x1234' });
    }));
    const pool = createRpcPool({ alchemyUrls: ['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key'], publicUrl: 'https://rpc.invalid' });

    await expect(pool.rpc('eth_chainId', [])).resolves.toBe('0x1234');
    expect(seen).toEqual(['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key']);
    const status = pool.poolStatus();
    expect(status.find((endpoint) => endpoint.id === 'alchemy#1')).toMatchObject({ failures: 1 });
    expect(status.find((endpoint) => endpoint.id === 'alchemy#2')).toMatchObject({ failures: 0, coolingForMs: 0 });
    expect(status.find((endpoint) => endpoint.id === 'alchemy#1')?.coolingForMs).toBeGreaterThan(0);
  });

  it('charges each isolated client provider attempt, including retry, and never uses the worker URL', async () => {
    const seen: string[] = [];
    const beforeAttempt = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return seen.length === 1 ? jsonResponse({}, 429) : jsonResponse({ result: '0x1234' });
    }));
    const pool = createRpcPool({ alchemyUrls: [], publicUrl: '',
      clientUrls: ['https://client-a.example/project-a', 'https://client-b.example/project-b'] });

    await expect(pool.rpc('eth_chainId', [], { beforeAttempt })).resolves.toBe('0x1234');
    expect(seen).toEqual(['https://client-a.example/project-a', 'https://client-b.example/project-b']);
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(pool.poolStatus().map((endpoint) => endpoint.id)).toEqual(['client#1', 'client#2']);
  });

  it('does not fall back from an isolated client pool to a configured worker endpoint', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return String(input).includes('client') ? jsonResponse({}, 503) : jsonResponse({ result: 'worker-fallback' });
    }));
    const isolatedPool = createRpcPool({ alchemyUrls: [], publicUrl: '',
      clientUrls: ['https://client.example/project'] });

    await expect(isolatedPool.rpc('eth_chainId', [])).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(seen).toEqual(['https://client.example/project']);
  });

  it('throws UPSTREAM_UNAVAILABLE after all available endpoints fail', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    vi.stubGlobal('fetch', fetchMock);
    const pool = createRpcPool({ alchemyUrls: ['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key'], publicUrl: 'https://rpc.invalid' });

    const failure = pool.rpc('eth_chainId', []);
    await expect(failure).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      status: 503,
      message: 'The network is not responding. Your funds are safe in your wallet. Please try again shortly.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(failure).rejects.toBeInstanceOf(AppError);
  });

  it.each([400, 200])('falls back for an Alchemy log range cap returned with HTTP %s', async (status) => {
    const params = [{ address: '0xa132671d343d93f3e3cf6edac8a90b6965e2d3c2', fromBlock: '0x100', toBlock: '0x1ff' }];
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'eth_getLogs', params });
      return seen.length === 1
        ? jsonResponse({ error: { code: -32600, message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.' } }, status)
        : jsonResponse({ result: [] });
    }));
    const pool = createRpcPool({ alchemyUrls: ['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key'], publicUrl: 'https://rpc.invalid' });
    await expect(pool.rpc('eth_getLogs', params, { alchemyOnly: true })).resolves.toEqual([]);
    expect(seen).toEqual(['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key']);
    expect(pool.poolStatus()[0]).toMatchObject({ failures: 1 });
  });

  it.each([400, 200])('does not retry an invalid log filter returned with HTTP %s', async (status) => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: -32602, message: 'block range extends beyond current head block' } }, status));
    vi.stubGlobal('fetch', fetchMock);
    const pool = createRpcPool({ alchemyUrls: ['https://alchemy.invalid/key'], publicUrl: 'https://rpc.invalid' });
    await expect(pool.rpc('eth_getLogs', [{ fromBlock: '0x100', toBlock: '0x1ff' }], { alchemyOnly: true })).rejects.toBeInstanceOf(RpcError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pool.poolStatus().every(s => s.failures === 0)).toBe(true);
  });

  it('prefers the public RPC for logs while retaining Alchemy rotation for other calls', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return jsonResponse({ result: [] });
    }));
    const pool = createRpcPool({ alchemyUrls: ['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key'], publicUrl: 'https://rpc.invalid' });
    await pool.rpc('eth_getLogs', [{}]);
    await pool.rpc('eth_blockNumber', []);
    await pool.rpc('eth_getLogs', [{}]);
    await pool.rpc('eth_blockNumber', []);
    expect(seen).toEqual(['https://rpc.invalid', 'https://alchemy-a.invalid/key', 'https://rpc.invalid', 'https://alchemy-b.invalid/key']);
  });

  it('falls back to Alchemy when the public log endpoint is unavailable', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return seen.length === 1 ? jsonResponse({}, 503) : jsonResponse({ result: [] });
    }));
    const pool = createRpcPool({ alchemyUrls: ['https://alchemy.invalid/key'], publicUrl: 'https://rpc.invalid' });
    await expect(pool.rpc('eth_getLogs', [{}])).resolves.toEqual([]);
    expect(seen).toEqual(['https://rpc.invalid', 'https://alchemy.invalid/key']);
  });

  it('throws a reverted execution error immediately without cooling the endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: 3, message: 'execution reverted', data: '0x' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pool = createRpcPool({ alchemyUrls: ['https://alchemy-a.invalid/key', 'https://alchemy-b.invalid/key'], publicUrl: 'https://rpc.invalid' });

    const failure = pool.rpc('eth_call', []);
    await expect(failure).rejects.toBeInstanceOf(RpcError);
    await expect(failure).rejects.toMatchObject({ code: 3, message: 'execution reverted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pool.poolStatus().every((status) => status.failures === 0 && status.coolingForMs === 0)).toBe(true);
  });
});
