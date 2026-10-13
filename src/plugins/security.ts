import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { allowedOrigins, config } from '../config.js';
import { errors } from '../lib/errors.js';
import { consume, limits } from '../lib/rateLimit.js';
import { readSessionToken } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string;
    ipHash: string;
  }
}

const security: FastifyPluginAsync = async (app) => {
  app.decorateRequest('clientIp', '');
  app.decorateRequest('ipHash', '');
  app.addHook('onRequest', async (request) => {
    const cloudflareIp = request.headers['cf-connecting-ip'];
    const ip = typeof cloudflareIp === 'string' ? cloudflareIp : request.ip;
    request.clientIp = ip;
    request.ipHash = createHash('sha256').update(config.IP_HASH_SALT + ip).digest('hex');

    const path = request.url.split('?', 1)[0];
    // The RPC relay applies its own per-session and per-IP limits.
    if (path !== '/health' && !(request.method === 'POST' && path === '/v1/rpc')) {
      // An invalid Authorization header cannot authenticate via cookies, but the
      // general limiter still counts its cookie identity before falling back to IP.
      const session = readSessionToken(request)?.token ?? request.cookies?.pa_session;
      const identity = session
        ? createHash('sha256').update(session).digest('hex')
        : request.ipHash;
      await consume(limits.general, identity);
    }

    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    // This exact provider callback authenticates its raw bytes with a separate HMAC secret.
    if (request.method === 'POST' && request.url.split('?', 1)[0] === '/v1/webhooks/izipay') return;
    if (request.headers['x-pingapp'] !== '1' ||
      typeof request.headers.origin !== 'string' ||
      !allowedOrigins.includes(request.headers.origin)) {
      throw errors.csrf();
    }
  });
};

export default fp(security, { name: 'security' });
