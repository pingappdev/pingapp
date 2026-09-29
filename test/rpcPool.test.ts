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
