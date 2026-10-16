import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { resolveClientIp } from './ipAddress.js';

export function clientIpForRequest(request: Pick<FastifyRequest, 'headers' | 'raw'>): string {
  const forwardedHeaders = request.headers as {
    'cf-connecting-ip'?: string | string[];
    'x-forwarded-for'?: string | string[];
  };
  return resolveClientIp(request.raw.socket.remoteAddress, forwardedHeaders, config.TRUSTED_PROXY_IPS);
}

export function hashClientIp(ip: string): string {
  return createHash('sha256').update(config.IP_HASH_SALT + ip).digest('hex');
}
