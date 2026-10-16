import type { FastifyRequest } from 'fastify';
import pino from 'pino';
import { config } from '../config.js';
import { clientIpForRequest, hashClientIp } from './requestIdentity.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  serializers: {
    req(request: FastifyRequest) {
      return {
        method: request.method,
        route: request.routeOptions?.url,
        ipHash: hashClientIp(clientIpForRequest(request)),
      };
    },
  },
  redact: {
    paths: [
      'phone', '*.phone', 'body.phone', 'req.body.phone',
      'code', '*.code', 'otp', 'to', '*.to',
      'headers.cookie', 'req.headers.cookie',
      'headers.authorization', 'req.headers.authorization', 'token', '*.token',
      'signature', '*.signature', 'SEVEN_API_KEY',
      'ROUTER_SIGNER_KEY', '*.ROUTER_SIGNER_KEY', 'RELAYER_PRIVATE_KEY', '*.RELAYER_PRIVATE_KEY',
      'routerSignerKey', '*.routerSignerKey', 'relayerPrivateKey', '*.relayerPrivateKey',
      'privateKey', '*.privateKey',
    ],
    censor: '[redacted]',
  },
  ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
