import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { errors } from '../lib/errors.js';

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

    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (request.headers['x-pingapp'] !== '1' ||
      typeof request.headers.origin !== 'string' ||
      !config.CORS_ORIGINS.includes(request.headers.origin)) {
      throw errors.csrf();
    }
  });
};

export default fp(security, { name: 'security' });
