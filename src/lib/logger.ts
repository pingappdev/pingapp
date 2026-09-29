import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  serializers: {
    req(request: FastifyRequest) {
      const cloudflareIp = request.headers['cf-connecting-ip'];
      const ip = typeof cloudflareIp === 'string' ? cloudflareIp : request.ip;
      return {
        method: request.method,
        route: request.routeOptions?.url,
        ipHash: createHash('sha256').update(config.IP_HASH_SALT + ip).digest('hex'),
      };
    },
  },
  redact: {
    paths: [
      'phone', '*.phone', 'body.phone', 'req.body.phone',
      'code', '*.code', 'otp', 'to', '*.to',
      'headers.cookie', 'req.headers.cookie',
      'signature', '*.signature', 'SEVEN_API_KEY',
    ],
    censor: '[redacted]',
  },
  ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
