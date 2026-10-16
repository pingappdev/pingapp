import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const integrationDescribe = process.env.AUD09_IDENTITY_INTEGRATION === '1' ? describe : describe.skip;
const resourcePrefixPattern = /^pingapp-audit-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const forwardedIpv4 = '203.0.113.51';
const forwardedIpv6 = '2001:db8::88';

type IdentityResponse = { clientIp: string; ipHash: string };
type LoggerStream = { write: (chunk: string | Buffer) => boolean };

function assertDisposableRedis(resourcePrefix: string): void {
  const redisUrl = new URL(process.env.REDIS_URL ?? '');
  const port = process.env.PINGAPP_AUD09_IDENTITY_REDIS_PORT;
  if (!resourcePrefixPattern.test(resourcePrefix) || !port || redisUrl.port !== port ||
      !['127.0.0.1', 'localhost'].includes(redisUrl.hostname)) {
    throw new Error('AUD-09 identity integration requires the matching prefixed loopback disposable Redis service.');
  }
}

function getIdentity(
  host: '127.0.0.1' | '::1', port: number, headers: Record<string, string>, localAddress?: string,
) {
  return new Promise<{ statusCode: number; body: IdentityResponse }>((resolve, reject) => {
    const request = httpRequest({ hostname: host, port, method: 'GET', path: '/identity', headers, localAddress }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode ?? 0, body: JSON.parse(body) as IdentityResponse });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

integrationDescribe('AUD-09 real HTTP trusted client identity', () => {
  let config: typeof import('../src/config.js')['config'];
  let logger: typeof import('../src/lib/logger.js')['logger'];
  let redis: typeof import('../src/lib/redis.js')['redis'];
  let generalIpLimiter: ReturnType<typeof import('../src/lib/rateLimit.js')['limiter']>;
  let hashClientIp: typeof import('../src/lib/requestIdentity.js')['hashClientIp'];
  let ipv4App: FastifyInstance;
  let ipv6App: FastifyInstance;
  let ipv4Port = 0;
  let ipv6Port = 0;
  let originalLoggerWrite: LoggerStream['write'] | undefined;
  const logLines: string[] = [];
  const visitedHashes = new Set<string>();

  async function startIdentityApp(host: '127.0.0.1' | '::1'): Promise<{ app: FastifyInstance; port: number }> {
    const app = Fastify({ loggerInstance: logger as FastifyBaseLogger, trustProxy: false });
    await app.register((await import('../src/plugins/security.js')).default);
    app.get('/identity', async (request) => ({ clientIp: request.clientIp, ipHash: request.ipHash }));
    await app.listen({ host, port: 0 });
    const address = app.server.address() as AddressInfo | null;
    if (!address || typeof address === 'string' || address.port < 1) {
      throw new Error(`AUD-09 identity integration failed to bind ${host} loopback.`);
    }
    return { app, port: address.port };
  }

  function remember(ip: string): string {
    const hash = hashClientIp(ip);
    visitedHashes.add(hash);
    return hash;
  }

  function serializedRequestLogs(): Array<{ req?: { route?: string; ipHash?: string } }> {
    return logLines.flatMap((line) => {
      try {
        return [JSON.parse(line) as { req?: { route?: string; ipHash?: string } }];
      } catch {
        return [];
      }
    }).filter((row) => row.req?.route === '/identity');
  }

  beforeAll(async () => {
    // The runner sets LOG_LEVEL=info so this imports the real production logger with its request serializer enabled.
    const resourcePrefix = process.env.PINGAPP_AUD09_IDENTITY_RESOURCE_PREFIX ?? '';
    assertDisposableRedis(resourcePrefix);
    if (!process.env.IP_HASH_SALT || process.env.IP_HASH_SALT === 'change-me' ||
        process.env.LOG_LEVEL !== 'info' || process.env.TRUSTED_PROXY_IPS !== '127.0.0.1,::1') {
      throw new Error('AUD-09 identity integration requires a synthetic hash salt, info request logging, and exact loopback proxy peers.');
    }

    const [configModule, loggerModule, redisModule, rateLimit, requestIdentity] = await Promise.all([
      import('../src/config.js'), import('../src/lib/logger.js'), import('../src/lib/redis.js'),
      import('../src/lib/rateLimit.js'), import('../src/lib/requestIdentity.js'),
    ]);
    config = configModule.config;
    logger = loggerModule.logger;
    redis = redisModule.redis;
    generalIpLimiter = rateLimit.limits.generalIp;
    hashClientIp = requestIdentity.hashClientIp;
    await redis.ping();
    if (config.TRUSTED_PROXY_IPS.join(',') !== '127.0.0.1,::1') {
      throw new Error('AUD-09 identity integration expected only the exact IPv4 and IPv6 loopback peers to be trusted.');
    }

    const streamSymbol = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.toString() === 'Symbol(pino.stream)');
    if (!streamSymbol) throw new Error('AUD-09 identity integration could not capture the production Pino stream.');
    const stream = (logger as unknown as Record<symbol, LoggerStream>)[streamSymbol];
    originalLoggerWrite = stream.write;
    stream.write = (chunk) => {
      logLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    };

    const ipv4 = await startIdentityApp('127.0.0.1');
    ipv4App = ipv4.app;
    ipv4Port = ipv4.port;
    const ipv6 = await startIdentityApp('::1');
    ipv6App = ipv6.app;
    ipv6Port = ipv6.port;
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([ipv4App?.close(), ipv6App?.close()]);
    if (logger && originalLoggerWrite) {
      const streamSymbol = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.toString() === 'Symbol(pino.stream)');
      if (streamSymbol) (logger as unknown as Record<symbol, LoggerStream>)[streamSymbol].write = originalLoggerWrite;
    }
    for (const hash of visitedHashes) await generalIpLimiter?.delete(hash).catch(() => undefined);
    await redis?.quit();
  }, 120_000);

  it('ignores forged forwarding headers from a direct IPv4 peer and keys both limiter and logger to the socket address', async () => {
    const response = await getIdentity('127.0.0.1', ipv4Port, {
      'cf-connecting-ip': forwardedIpv4,
      'x-forwarded-for': '198.51.100.77',
    }, '127.0.0.2');
    const socketHash = remember('127.0.0.2');
    const forgedHash = remember(forwardedIpv4);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ clientIp: '127.0.0.2', ipHash: socketHash });
    await expect(generalIpLimiter.get(socketHash)).resolves.toMatchObject({ remainingPoints: 599 });
    await expect(generalIpLimiter.get(forgedHash)).resolves.toBeNull();

    const requestLogs = serializedRequestLogs();
    expect(requestLogs.some((row) => row.req?.ipHash === socketHash)).toBe(true);
    expect(requestLogs.some((row) => row.req?.ipHash === forgedHash)).toBe(false);
    expect(logLines.join('')).not.toContain('127.0.0.2');
    expect(logLines.join('')).not.toContain(forwardedIpv4);
  }, 120_000);

  it('uses forwarded identity only for the exact trusted IPv4 and IPv6 peers', async () => {
    const trustedIpv4 = await getIdentity('127.0.0.1', ipv4Port, {
      'cf-connecting-ip': forwardedIpv4,
      'x-forwarded-for': '198.51.100.200',
    });
    const trustedIpv4Hash = remember(forwardedIpv4);

    expect(trustedIpv4.statusCode).toBe(200);
    expect(trustedIpv4.body).toEqual({ clientIp: forwardedIpv4, ipHash: trustedIpv4Hash });
    await expect(generalIpLimiter.get(trustedIpv4Hash)).resolves.toMatchObject({ remainingPoints: 599 });

    const trustedIpv6 = await getIdentity('::1', ipv6Port, { 'x-forwarded-for': forwardedIpv6 });
    const trustedIpv6Hash = remember(forwardedIpv6);

    expect(trustedIpv6.statusCode).toBe(200);
    expect(trustedIpv6.body).toEqual({ clientIp: forwardedIpv6, ipHash: trustedIpv6Hash });
    await expect(generalIpLimiter.get(trustedIpv6Hash)).resolves.toMatchObject({ remainingPoints: 599 });

    const requestLogs = serializedRequestLogs();
    expect(requestLogs.some((row) => row.req?.ipHash === trustedIpv4Hash)).toBe(true);
    expect(requestLogs.some((row) => row.req?.ipHash === trustedIpv6Hash)).toBe(true);
    expect(logLines.join('')).not.toContain(forwardedIpv4);
    expect(logLines.join('')).not.toContain(forwardedIpv6);
  }, 120_000);
});
