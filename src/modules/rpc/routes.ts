import type { FastifyPluginAsync } from 'fastify';
import { config, rpcSettings } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { consume, limiter } from '../../lib/rateLimit.js';
import { clientRpc, hasClientRpcEndpoints, rpc, RpcError } from '../../lib/rpcPool.js';
import { rpcEndpointSecrets } from '../../lib/rpcEndpoint.js';
import { checkBatch, checkRequest, isRecord, isRpcRequest } from './policy.js';

const userLimiter = limiter('rpc_session', 600, 60);
const ipLimiter = limiter('rpc_ip', 300, 60);
const rawTxLimiter = limiter('rpc_raw_tx', 30, 60);
const userAttemptLimiter = limiter('rpc_relay_user_attempt', rpcSettings.userAttemptsPerMinute, 60);
const globalAttemptLimiter = limiter('rpc_relay_global_attempt', rpcSettings.globalAttemptsPerMinute, 60);

function configuredRpcSecrets(): string[] {
  return [...config.ALCHEMY_API_KEYS, ...rpcSettings.clientUrls.flatMap(rpcEndpointSecrets)]
    .filter(Boolean).sort((left, right) => right.length - left.length);
}

function safeRevertData(value: unknown): unknown {
  if (typeof value === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(value) &&
      !configuredRpcSecrets().includes(value)) return value;
  return safeUpstream(value);
}

function requestId(entry: unknown): string | number | null {
  if (!isRecord(entry)) return null;
  const id = entry.id;
  return typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)) ? id : null;
}

function rpcError(entry: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: requestId(entry), error: { code, message, ...(data === undefined ? {} : { data }) } };
}

// Preserve revert bytes while withholding provider credentials and diagnostics.
function safeUpstream(value: unknown): unknown {
  if (typeof value === 'string') {
    let safe = value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted]');
    for (const secret of configuredRpcSecrets()) {
      safe = safe.split(secret).join('[redacted]');
    }
    return safe.replace(/\n\s*at [\s\S]*/g, '');
  }
  if (Array.isArray(value)) return value.map(safeUpstream);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value)
    // Provider diagnostics can use an endpoint URL or credential as a map key.
    // Drop those properties instead of exposing keys or merging redacted keys.
    .filter(([key]) => !/^stack(?:trace)?$/i.test(key) && safeUpstream(key) === key)
    .map(([key, child]) => [key, key.toLowerCase() === 'data' ? safeRevertData(child) : safeUpstream(child)]));
  return value;
}

const routes: FastifyPluginAsync = async (app) => {
  // The global handler treats parser errors as INTERNAL. Keep this route's
  // malformed/oversize bodies in the normal HTTP validation error envelope.
  app.setErrorHandler((error, _request, reply) => {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.code(code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 413 : 400)
        .send({ error: { code: 'VALIDATION', message: 'Invalid request body.' } });
    }
    throw error;
  });
  app.post('/rpc', { bodyLimit: config.RPC_RELAY_MAX_BODY_BYTES }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!config.RPC_RELAY_ENABLED) throw new AppError('RPC_RELAY_DISABLED', 503, 'RPC relay is disabled.');
    if (rpcSettings.isolationRequired && !hasClientRpcEndpoints()) {
      throw new AppError('RPC_RELAY_ISOLATION_UNAVAILABLE', 503, 'The isolated RPC relay is not configured.');
    }

    const batch = Array.isArray(request.body);
    const entries: unknown[] = batch ? request.body as unknown[] : [request.body];
    const key = request.user ? `user:${request.user.id}` : `ip:${request.ipHash}`;
    // Charge each entry, so batches cannot multiply the configured budget.
    await consume(request.user ? userLimiter : ipLimiter, key, Math.max(1, entries.length));
    if (batch) {
      const policy = checkBatch(entries, { maxBatch: config.RPC_RELAY_MAX_BATCH });
      if (!policy.ok) return [rpcError(null, policy.code, policy.message)];
    }
    const rawTxCount = entries.filter((entry) => isRecord(entry) && entry.method === 'eth_sendRawTransaction').length;
    // Consume before local policy validation: malformed raw-tx spam counts too,
    // and a rejected batch never partially submits transactions.
    if (rawTxCount) await consume(rawTxLimiter, key, rawTxCount);

    const methods = entries.filter(isRpcRequest).map((entry) => entry.method)
      .filter((method) => {
        const policy = checkRequest({ jsonrpc: '2.0', method });
        return policy.ok || policy.code !== -32601;
      });
    request.log.info({ methods }, 'RPC relay request');
    const relayRpc = rpcSettings.isolationRequired || rpcSettings.clientUrls.length > 0 ? clientRpc : rpc;
    const attemptKey = request.user ? `user:${request.user.id}` : `ip:${request.ipHash}`;
    const beforeAttempt = async () => {
      await consume(userAttemptLimiter, attemptKey);
      await consume(globalAttemptLimiter, 'all');
    };
    const responses = await Promise.all(entries.map(async (entry) => {
      const policy = checkRequest(entry);
      if (!policy.ok) return rpcError(entry, policy.code, policy.message);
      if (!isRpcRequest(entry)) return rpcError(entry, -32600, 'invalid request');
      try {
        return { jsonrpc: '2.0', id: requestId(entry), result: await relayRpc(entry.method, entry.params ?? [], { beforeAttempt }) };
      } catch (error) {
        // Attempt budgets are charged inside a batch's concurrent provider calls.
        // Return a per-entry JSON-RPC error so admitted siblings keep their results,
        // especially the hash for a transaction that was actually broadcast.
        if (error instanceof AppError && error.status === 429) {
          return rpcError(entry, -32005, 'RPC attempt budget exceeded');
        }
        if (error instanceof RpcError && !(error.code >= 400 && error.code <= 599)) {
          return rpcError(entry, error.code, safeUpstream(error.message) as string, safeRevertData(error.data));
        }
        return rpcError(entry, -32603, 'upstream unavailable');
      }
    }));
    return batch ? responses : responses[0];
  });
};

export default routes;
