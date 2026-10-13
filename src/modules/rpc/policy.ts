export type PolicyResult = { ok: true } | { ok: false; code: number; message: string };
export type RpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: unknown[] };

const allowedMethods = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_call', 'eth_getBalance',
  'eth_getCode', 'eth_getStorageAt', 'eth_estimateGas', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber',
  'eth_sendRawTransaction', 'eth_getLogs',
]);
const invalidRequest = (): PolicyResult => ({ ok: false, code: -32600, message: 'invalid request' });
const invalidParams = (message: string): PolicyResult => ({ ok: false, code: -32602, message });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRpcRequest(entry: unknown): entry is RpcRequest {
  return isRecord(entry) && entry.jsonrpc === '2.0' && typeof entry.method === 'string' &&
    (entry.id === undefined || entry.id === null || typeof entry.id === 'string' ||
      (typeof entry.id === 'number' && Number.isSafeInteger(entry.id))) &&
    (entry.params === undefined || Array.isArray(entry.params));
}

function blockNumber(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^0x[\da-f]+$/i.test(value)) return BigInt(value);
  return null;
}

export function checkBatch(entries: unknown[], opts: { maxBatch: number }): PolicyResult {
  if (entries.length === 0) return invalidRequest();
  if (entries.length > opts.maxBatch) return invalidParams('batch too large');
  return { ok: true };
}

export function checkRequest(entry: unknown, opts: { maxCallDataBytes?: number } = {}): PolicyResult {
  if (!isRpcRequest(entry)) return invalidRequest();
  if (!allowedMethods.has(entry.method)) return { ok: false, code: -32601, message: 'method not allowed' };
  const params = entry.params ?? [];
  if (entry.method === 'eth_getBlockByNumber' && params[1] !== false) {
    return invalidParams('full transactions not allowed');
  }
  if (entry.method === 'eth_getLogs') {
    const filter = params[0];
    if (!isRecord(filter)) return invalidParams('invalid log filter');
    if ('blockHash' in filter) {
      if (typeof filter.blockHash !== 'string' || !/^0x[\da-f]{64}$/i.test(filter.blockHash) ||
        'fromBlock' in filter || 'toBlock' in filter) return invalidParams('invalid blockHash filter');
    } else {
      const from = blockNumber(filter.fromBlock);
      const to = blockNumber(filter.toBlock);
      if (from === null || to === null || to < from || to - from + 1n > 10_000n) {
        return invalidParams('logs require a numeric range of at most 10000 blocks');
      }
    }
  }
  if (entry.method === 'eth_call') {
    if (!isRecord(params[0])) return invalidParams('invalid call');
    // Nodes accept both names; neither may bypass the byte cap.
    for (const field of ['data', 'input']) {
      const data = params[0][field];
      if (data !== undefined && (typeof data !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(data) ||
        (data.length - 2) / 2 > (opts.maxCallDataBytes ?? 32 * 1024))) {
        return invalidParams('call data exceeds limit or is not hex bytes');
      }
    }
  }
  if (entry.method === 'eth_sendRawTransaction' &&
    (params.length !== 1 || typeof params[0] !== 'string' || !/^0x(?:[\da-f]{2})+$/i.test(params[0]))) {
    return invalidParams('invalid raw transaction');
  }
  return { ok: true };
}
