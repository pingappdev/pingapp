import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { allowedOrigins, config } from '../config.js';
import { errors } from '../lib/errors.js';
import { consume, limiter, limits } from '../lib/rateLimit.js';

// Security runs before auth and parsing. This request budget also counts bad
// JSON/oversize bodies; verified-session and batch-entry budgets run in relay.
const rpcRequestIpLimiter = limiter('rpc_request_ip', 600, 60);

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
    if (request.method === 'POST' && path === '/v1/rpc') {
      await consume(rpcRequestIpLimiter, request.ipHash);
    }
    // The RPC relay applies its own per-session and per-IP limits.
    if (path !== '/health' && !(request.method === 'POST' && path === '/v1/rpc')) {
      // This pre-auth budget protects parsing and session lookup. A supplied
      // cookie or bearer token never creates a fresh anonymous bucket.
      await consume(limits.generalIp, request.ipHash);
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
