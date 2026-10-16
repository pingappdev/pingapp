import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const rpcDescribe = process.env.RPC_RELAY_INTEGRATION === '1' ? describe : describe.skip;
const webhookDescribe = process.env.AUD09_WEBHOOK_INTEGRATION === '1' ? describe : describe.skip;
const auditPrefixPattern = /^pingapp-audit-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertDisposableDatabase(resourcePrefix: string, portVariable: string, databaseUrl: string) {
  const url = new URL(databaseUrl);
  const port = process.env[portVariable];
  const expectedDatabase = resourcePrefix.replaceAll('-', '_');
  if (!auditPrefixPattern.test(resourcePrefix) || url.pathname !== `/${expectedDatabase}` ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) || !port || url.port !== port) {
    throw new Error('AUD-09 integration requires the matching explicitly prefixed loopback disposable PostgreSQL service.');
  }
}

type UpstreamName = 'clientA' | 'clientB' | 'worker';

rpcDescribe('AUD-09 isolated RPC relay integration', () => {
  let upstreams: Record<UpstreamName, Server>;
  let ports: Record<UpstreamName, number>;
  let routeApp: ReturnType<typeof Fastify>;
  let redis: typeof import('../src/lib/redis.js')['redis'];
  let userAttemptLimiter: ReturnType<typeof import('../src/lib/rateLimit.js')['limiter']>;
  let globalAttemptLimiter: ReturnType<typeof import('../src/lib/rateLimit.js')['limiter']>;
  let currentUserId = '';
  let retryTarget: UpstreamName | null = null;
  let rejectNextRetryTarget = false;
  const requests: Array<{ name: UpstreamName; method: string }> = [];

  async function listen(server: Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake RPC upstream failed to bind loopback.');
    return address.port;
  }

  function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  beforeAll(async () => {
    const resourcePrefix = process.env.PINGAPP_AUD09_RPC_RESOURCE_PREFIX ?? '';
    assertDisposableDatabase(resourcePrefix, 'PINGAPP_AUD09_POSTGRES_PORT', process.env.DATABASE_URL ?? '');
    if (!process.env.REDIS_URL || !process.env.PINGAPP_AUD09_REDIS_PORT) {
      throw new Error('AUD-09 RPC integration requires the matching disposable Redis service.');
    }
    const redisUrl = new URL(process.env.REDIS_URL);
    if (!['127.0.0.1', 'localhost'].includes(redisUrl.hostname) || redisUrl.port !== process.env.PINGAPP_AUD09_REDIS_PORT) {
      throw new Error('AUD-09 RPC integration requires the matching loopback disposable Redis service.');
    }

    vi.resetModules();
    const counts: Record<UpstreamName, number> = { clientA: 0, clientB: 0, worker: 0 };
    const makeUpstream = (name: UpstreamName) => createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as { method?: string };
        counts[name] += 1;
        requests.push({ name, method: String(body.method ?? '') });
        if (name === 'worker') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'worker-fallback' }));
          return;
        }
        if (retryTarget === name && rejectNextRetryTarget) {
          rejectNextRetryTarget = false;
          response.writeHead(429, { 'content-type': 'application/json' });
          response.end('{}');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `response-${name}` }));
      });
    });

    upstreams = { clientA: makeUpstream('clientA'), clientB: makeUpstream('clientB'), worker: makeUpstream('worker') };
    ports = {
      clientA: await listen(upstreams.clientA),
      clientB: await listen(upstreams.clientB),
      worker: await listen(upstreams.worker),
    };

    process.env.RPC_RELAY_ENABLED = 'true';
    process.env.RPC_RELAY_ISOLATION_REQUIRED = 'true';
    process.env.RPC_RELAY_USER_ATTEMPTS_PER_MINUTE = '2';
    process.env.RPC_RELAY_GLOBAL_ATTEMPTS_PER_MINUTE = '3';
    process.env.PUBLIC_RPC_URL = `http://127.0.0.1:${ports.worker}/worker-project`;
    process.env.CLIENT_RPC_URLS = [
      `http://127.0.0.1:${ports.clientA}/client-a?api_key=synthetic-client-a`,
      `http://127.0.0.1:${ports.clientB}/client-b?api_key=synthetic-client-b`,
    ].join(',');

    const [configModule, redisModule, rateLimit, routes] = await Promise.all([
      import('../src/config.js'),
      import('../src/lib/redis.js'),
      import('../src/lib/rateLimit.js'),
      import('../src/modules/rpc/routes.js'),
    ]);
    if (!configModule.rpcSettings.isolationRequired || configModule.rpcSettings.clientUrls.length !== 2 ||
        configModule.config.RPC_RELAY_USER_ATTEMPTS_PER_MINUTE !== 2 ||
        configModule.config.RPC_RELAY_GLOBAL_ATTEMPTS_PER_MINUTE !== 3) {
      throw new Error('AUD-09 RPC integration requires strict isolation and test-sized user/global attempt limits.');
    }
    redis = redisModule.redis;
    await redis.ping();
    userAttemptLimiter = rateLimit.limiter('rpc_relay_user_attempt', 2, 60);
    globalAttemptLimiter = rateLimit.limiter('rpc_relay_global_attempt', 3, 60);
    routeApp = Fastify({ logger: false });
    routeApp.decorateRequest('user', null);
    routeApp.decorateRequest('ipHash', '');
    routeApp.addHook('onRequest', async (request: FastifyRequest) => {
      const decorated = request as FastifyRequest & { user: { id: string; address: string }; ipHash: string };
      decorated.user = { id: currentUserId, address: '0x0000000000000000000000000000000000000001' };
      decorated.ipHash = `audit09-${currentUserId}`;
    });
    routeApp.setErrorHandler((error: FastifyError | Error, _request: FastifyRequest, reply: FastifyReply) => {
      const appError = error as Error & { status?: number; code?: string };
      if (typeof appError.status === 'number' && typeof appError.code === 'string') {
        return reply.code(appError.status).send({ error: { code: appError.code } });
      }
      return reply.code(500).send({ error: { code: 'INTERNAL' } });
    });
    await routeApp.register(routes.default, { prefix: '/v1' });
    await routeApp.ready();

    // Keep the disposable runner's aggregate counters independent of any prior local invocation.
    await globalAttemptLimiter.delete('all');
    expect(counts).toEqual({ clientA: 0, clientB: 0, worker: 0 });
  }, 120_000);

  afterAll(async () => {
    await routeApp?.close();
    await redis?.quit();
    if (upstreams) await Promise.all(Object.values(upstreams).map(close));
  }, 120_000);

  async function resetBudgets(userId: string) {
    await userAttemptLimiter.delete(`user:${userId}`);
    await globalAttemptLimiter.delete('all');
    currentUserId = userId;
  }

  async function requestRpc(sessionId: string) {
    return routeApp.inject({
      method: 'POST', url: '/v1/rpc',
      headers: { 'x-test-session': sessionId },
      payload: { jsonrpc: '2.0', id: sessionId, method: 'eth_chainId', params: [] },
    });
  }

  it('uses a stable user allowance across session rotation and enforces a global attempt cap', async () => {
    const userId = randomUUID();
    await resetBudgets(userId);
    const first = await requestRpc('cookie-session-1');
    const second = await requestRpc('bearer-session-2');
    const third = await requestRpc('cookie-session-3');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
    expect(third.json()).toMatchObject({ error: { code: -32005, message: 'RPC attempt budget exceeded' } });
    expect(requests.filter((request) => request.name !== 'worker')).toHaveLength(2);

    currentUserId = randomUUID();
    expect((await requestRpc('new-user')).statusCode).toBe(200);
    currentUserId = randomUUID();
    const globallyLimited = await requestRpc('another-user');
    expect(globallyLimited.statusCode).toBe(200);
    expect(globallyLimited.json()).toMatchObject({ error: { code: -32005 } });
    expect(requests.filter((request) => request.name !== 'worker')).toHaveLength(3);
    expect(requests.some((request) => request.name === 'worker')).toBe(false);
  }, 120_000);

  it('charges every isolated retry before fetch and preserves the client-only boundary', async () => {
    const userId = randomUUID();
    await resetBudgets(userId);
    // A successful call advances the round-robin cursor, so the next endpoint is the one that will reject.
    const before = requests.length;
    const warmup = await requestRpc('warmup');
    expect(warmup.statusCode).toBe(200);
    const lastEndpoint = requests.at(-1)?.name;
    if (lastEndpoint !== 'clientA' && lastEndpoint !== 'clientB') throw new Error('Expected a client endpoint during warmup.');
    retryTarget = lastEndpoint === 'clientA' ? 'clientB' : 'clientA';
    rejectNextRetryTarget = true;

    // Allow exactly two real provider attempts for this user: the 429 and its retry.
    await userAttemptLimiter.delete(`user:${userId}`);
    const response = await requestRpc('retry-session');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: expect.stringMatching(/^response-client/) });
    expect(requests.slice(before + 1).map((request) => request.name)).toEqual([retryTarget, lastEndpoint]);
    expect(rejectNextRetryTarget).toBe(false);
    expect(requests.some((request) => request.name === 'worker')).toBe(false);
  }, 120_000);
});

webhookDescribe('AUD-09 Izipay webhook integration', () => {
  const resourcePrefix = process.env.PINGAPP_AUD09_WEBHOOK_RESOURCE_PREFIX ?? '';
  const signatureSecret = 'aud09-synthetic-webhook-secret';
  let app: ReturnType<typeof Fastify>;
  let db: typeof import('../src/db/client.js')['db'];
  let sql: typeof import('../src/db/client.js')['sql'];
  let events: typeof import('../src/db/schema.js')['cardWebhookEvents'];
  let eventId = '';

  function sign(raw: string) {
    return createHmac('sha256', signatureSecret).update(Buffer.from(raw)).digest('hex');
  }

  beforeAll(async () => {
    const [dbClient, schema, configModule, routeModule, { AppError }] = await Promise.all([
      import('../src/db/client.js'),
      import('../src/db/schema.js'),
      import('../src/config.js'),
      import('../src/modules/card-webhooks/routes.js'),
      import('../src/lib/errors.js'),
    ]);
    assertDisposableDatabase(resourcePrefix, 'PINGAPP_AUD09_POSTGRES_PORT', configModule.config.DATABASE_URL);
    if (configModule.config.IZIPAY_WEBHOOK_SECRET !== signatureSecret) {
      throw new Error('AUD-09 webhook integration requires its fixed synthetic HMAC secret.');
    }
    db = dbClient.db;
    sql = dbClient.sql;
    events = schema.cardWebhookEvents;
    eventId = `aud09-${randomUUID()}`;
    app = Fastify({ logger: false });
    app.setErrorHandler((error: FastifyError | Error, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code } });
      return reply.code(500).send({ error: { code: 'INTERNAL' } });
    });
    await app.register(routeModule.default, { prefix: '/v1' });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (eventId && db && events) {
      await db.delete(events).where((await import('drizzle-orm')).eq(events.providerEventId, eventId)).catch(() => undefined);
    }
    await app?.close();
    await sql?.end();
  }, 120_000);

  it('accepts signed historical provider timestamps and deduplicates exact retries by raw payload', async () => {
    const raw = JSON.stringify({ id: eventId, type: 'card.updated', created: 946684800,
      data: { card_id: 'synthetic-card-123', card_number: '4111111111111111' } });
    const signature = sign(raw);
    const post = (body: string, header: string) => app.inject({ method: 'POST', url: '/v1/webhooks/izipay',
      headers: { 'content-type': 'application/json', 'x-izipay-signature': header }, payload: body });

    const accepted = await post(raw, signature);
    const exactRetry = await post(raw, signature);
    expect(accepted.statusCode).toBe(200);
    expect(exactRetry.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ received: true });
    expect(exactRetry.json()).toEqual({ received: true });

    const staleSignatureForChangedBytes = await post(`${raw} `, signature);
    expect(staleSignatureForChangedBytes.statusCode).toBe(401);
    const conflictingEventId = JSON.stringify({ id: eventId, type: 'card.updated', created: 946684800,
      data: { card_id: 'different-synthetic-card' } });
    const conflict = await post(conflictingEventId, sign(conflictingEventId));
    expect(conflict.statusCode).toBe(409);

    const saved = await db.select().from(events).where((await import('drizzle-orm')).eq(events.providerEventId, eventId));
    expect(saved).toHaveLength(1);
    expect(saved[0].eventAt?.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(saved[0].payload).toEqual({ card_id: 'synthetic-card-123' });
    expect(JSON.stringify(saved[0])).not.toContain('4111111111111111');
  }, 120_000);
});
