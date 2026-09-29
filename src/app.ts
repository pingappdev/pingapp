import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyError } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError, errors } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { loadRouteModules } from './lib/modules.js';
import auth from './plugins/auth.js';
import security from './plugins/security.js';

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger as FastifyBaseLogger, trustProxy: true, bodyLimit: 64 * 1024, genReqId: () => randomUUID() });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error.status === 429 && typeof error.details?.retryAfterSec === 'number') {
        reply.header('Retry-After', String(error.details.retryAfterSec));
      }
      return reply.code(error.status).send({ error: {
        code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}),
      } });
    }
    if (error instanceof ZodError || 'validation' in error) {
      const issues = error instanceof ZodError ? error.issues : (error as FastifyError).validation;
      return reply.code(400).send({ error: { code: 'VALIDATION', message: 'Invalid request.', details: { issues } } });
    }
    request.log.error({ err: error }, 'unhandled request error');
    const internal = errors.internal();
    return reply.code(internal.status).send({ error: { code: internal.code, message: internal.message } });
  });
  app.setNotFoundHandler((_request, reply) => {
    const notFound = errors.notFound();
    return reply.code(404).send({ error: { code: notFound.code, message: notFound.message } });
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-pingapp'],
    maxAge: 600,
  });
  await app.register(security);
  await app.register(auth);
  await loadRouteModules(app);
  await app.ready();
  return app;
}
