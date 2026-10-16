import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const integrationDescribe = process.env.F1_INTEGRATION === '1' ? describe : describe.skip;
const makePhone = (index: number) => `+447400123${String(index).padStart(3, '0')}`;
const makeToken = () => randomBytes(32).toString('base64url');
const ipHash = (ip: string) => createHash('sha256').update(`${process.env.IP_HASH_SALT}${ip}`).digest('hex');

let app: ReturnType<typeof Fastify>;
let db: typeof import('../src/db/client.js')['db'];
let sql: typeof import('../src/db/client.js')['sql'];
let redis: typeof import('../src/lib/redis.js')['redis'];
let users: typeof import('../src/db/schema.js')['users'];
let sessions: typeof import('../src/db/schema.js')['sessions'];
let userId = '';
let userAddress = '';
let contactsApi: typeof import('../src/modules/contacts/service.js');
let resolver: typeof import('../src/modules/resolve/service.js');
let limits: typeof import('../src/lib/rateLimit.js')['limits'];

integrationDescribe('AUD-01 Redis/Postgres integration', () => {
  beforeAll(async () => {
    [{ db, sql }, { redis }, { users, sessions }, contactsApi, resolver, { limits }] = await Promise.all([
      import('../src/db/client.js'),
      import('../src/lib/redis.js'),
      import('../src/db/schema.js'),
      import('../src/modules/contacts/service.js'),
      import('../src/modules/resolve/service.js'),
      import('../src/lib/rateLimit.js'),
    ]);

    userId = randomUUID();
    userAddress = `0x${randomBytes(20).toString('hex')}`;
    await db.insert(users).values({ id: userId, address: userAddress, displayName: 'Audit F1 test' });
    app = Fastify({ trustProxy: false, logger: false });
    await app.register(cookie);
    await app.register((await import('../src/plugins/security.js')).default);
    await app.register((await import('../src/plugins/auth.js')).default);
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      const appError = error as unknown as { status?: unknown; code?: unknown };
      const status = typeof appError.status === 'number'
        ? appError.status
        : 500;
      const code = typeof appError.code === 'string'
        ? appError.code
        : 'INTERNAL';
      return reply.code(status).send({ error: { code } });
    });
    app.get('/v1/f1-probe', async () => ({ ok: true }));
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (userId) await db.delete(users).where((await import('drizzle-orm')).eq(users.id, userId));
    await app?.close();
    await redis?.quit();
    await sql?.end();
  }, 120_000);

  it('keeps create, phone/name update and list from granting membership to unchecked phones', async () => {
    const saved = [] as Array<{ id: string; phone: string }>;
    for (let index = 0; index < 61; index += 1) {
      const phone = makePhone(index);
      const contact = await contactsApi.create(userId, { name: `Contact ${index}`, phone });
      expect(contact.membershipStatus).toBe('unknown');
      saved.push({ id: contact.id, phone });
    }

    for (let index = 0; index < 59; index += 1) {
      await resolver.resolvePhone({ id: userId, address: userAddress }, saved[index].phone, 'resolve-ip');
      if (index === 29) await limits.resolveUserMin.delete(userId);
    }

    await limits.resolveUserMin.delete(userId);
    const concurrent = await Promise.allSettled(
      Array.from({ length: 30 }, (_, offset) => resolver.resolvePhone(
        { id: userId, address: userAddress }, makePhone(61 + offset), 'resolve-ip',
      )),
    );
    const accepted = concurrent.filter((result) => result.status === 'fulfilled');
    const rejected = concurrent.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(29);
    expect(rejected.every((result) => result.status === 'rejected' &&
      (result.reason as { code?: string }).code === 'RATE_LIMITED')).toBe(true);

    await limits.resolveUserMin.delete(userId);
    await expect(resolver.resolvePhone(
      { id: userId, address: userAddress }, saved[59].phone, 'resolve-ip',
    )).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });

    const uncheckedBefore = await contactsApi.update(userId, saved[60].id, { name: 'Renamed contact' });
    expect(uncheckedBefore.membershipStatus).toBe('unknown');
    const uncheckedAfterPhoneChange = await contactsApi.update(userId, saved[60].id, { phone: makePhone(91) });
    expect(uncheckedAfterPhoneChange.membershipStatus).toBe('unknown');
    const newlySaved = await contactsApi.create(userId, { name: 'Unresolved', phone: makePhone(92) });
    expect(newlySaved.membershipStatus).toBe('unknown');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await contactsApi.list(userId);
      expect(listed.find((contact) => contact.id === saved[0].id)?.membershipStatus).toBe('not_registered');
      expect(listed.find((contact) => contact.id === saved[59].id)?.membershipStatus).toBe('unknown');
      expect(listed.find((contact) => contact.id === saved[60].id)?.membershipStatus).toBe('unknown');
    }
    await limits.resolveUserMin.delete(userId);
    await expect(resolver.resolvePhone(
      { id: userId, address: userAddress }, makePhone(92), 'resolve-ip',
    )).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  }, 120_000);

  it('shares the authenticated general budget across cookie and bearer session rotation', async () => {
    const tokens = Array.from({ length: 121 }, makeToken);
    await db.insert(sessions).values(tokens.map((token) => ({
      userId,
      tokenHash: (awaitHash(token)),
      expiresAt: new Date(Date.now() + 86_400_000),
      lastSeenAt: new Date(),
    })));
    const address = '198.51.100.12';
    await limits.general.delete(userId);
    await limits.generalIp.delete(ipHash(address));

    const statuses: number[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const headers = index % 2 === 0
        ? { cookie: `pa_session=${tokens[index]}` }
        : { authorization: `Bearer ${tokens[index]}` };
      const response = await app.inject({
        method: 'GET', url: '/v1/f1-probe', headers: { ...headers, 'x-forwarded-for': address },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  }, 120_000);

  it('applies an anonymous IP budget even when every request invents a new cookie', async () => {
    const address = '198.51.100.13';
    await limits.generalIp.delete(ipHash(address));
    const statuses: number[] = [];
    for (let index = 0; index < 601; index += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/f1-probe',
        headers: { cookie: `pa_session=${makeToken()}`, 'x-forwarded-for': address },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 600).every((status) => status === 200)).toBe(true);
    expect(statuses[600]).toBe(429);
  }, 120_000);
});

function awaitHash(token: string): string {
  // Keep the session fixture in step with the production token-hash function.
  return createHash('sha256').update(token).digest('hex');
}
