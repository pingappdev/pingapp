import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mutations = vi.hoisted(() => ({ transaction: vi.fn(), encrypt: vi.fn() }));
vi.mock('../src/db/client.js', () => ({ db: { transaction: mutations.transaction } }));
vi.mock('../src/modules/cards/provider.js', () => ({ provider: {} }));
vi.mock('../src/modules/cards/settings.js', () => ({
  providerScope: 'izipay:sandbox:unit-test', encryptCardData: mutations.encrypt,
  decryptCardData: vi.fn(), cardsEnabled: () => false, requireCards: vi.fn(), unavailable: vi.fn(),
}));
vi.mock('../src/plugins/auth.js', () => ({ requireAuth: vi.fn(async () => {}), requireFreshAuth: vi.fn(async () => {}) }));
import { AppError } from '../src/lib/errors.js';
import { requireExpectedAccount } from '../src/modules/cards/domain.js';
import routes from '../src/modules/cards/routes.js';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const app = Fastify();
beforeAll(async () => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => { request.user = { id: other, address: '0x' + '1'.repeat(40) }; });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof AppError ? error.status : error && typeof error === 'object' && 'validation' in error ? 400 : 500;
    return reply.code(status).send({ code: error instanceof AppError ? error.code : 'VALIDATION' });
  });
  await app.register(routes, { prefix: '/v1' });
  await app.ready();
});
afterAll(() => app.close());
beforeEach(() => { vi.clearAllMocks(); });

describe('card forms bind their rendered account to the cookie account', () => {
  const issue = { product: 'visa', network: 'tron', requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  it.each([
    { method: 'PATCH' as const, url: '/v1/cards/profile', body: { email: 'original-owner@example.com' } },
    { method: 'POST' as const, url: '/v1/cards/issue', body: issue },
  ])('rejects another tab switching accounts before $method $url can write', async ({ method, url, body }) => {
    const response = await app.inject({ method, url, payload: { ...body, expectedUserId: owner } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('ACCOUNT_CHANGED');
    expect(mutations.transaction).not.toHaveBeenCalled();
    expect(mutations.encrypt).not.toHaveBeenCalled();
  });
  it.each([
    { method: 'PATCH' as const, url: '/v1/cards/profile', body: { email: 'owner@example.com' } },
    { method: 'POST' as const, url: '/v1/cards/issue', body: issue },
  ])('requires a valid expectedUserId on $method $url', async ({ method, url, body }) => {
    for (const payload of [body, { ...body, expectedUserId: 'not-a-uuid' }]) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode).toBe(400);
      expect(mutations.transaction).not.toHaveBeenCalled();
      expect(mutations.encrypt).not.toHaveBeenCalled();
    }
  });
  it('accepts the same UUID regardless of casing', () => {
    expect(() => requireExpectedAccount(owner, owner.toUpperCase())).not.toThrow();
  });
});
