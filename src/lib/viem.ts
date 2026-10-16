import { createPublicClient, custom } from 'viem';
import { config } from '../config.js';
import { viemChain } from './chain.js';
import { rpc } from './rpcPool.js';

export const publicClient = createPublicClient({
  chain: viemChain,
  transport: custom({ request: ({ method, params }) => rpc(method, params ?? []) }),
  batch: { multicall: true },
});

// Startup checks use a tighter per-endpoint timeout so an unavailable RPC cannot
// keep API/worker shutdown waiting on the general-purpose request retry window.
export const routerStartupClient = createPublicClient({
  chain: viemChain,
  transport: custom({ request: ({ method, params }) => rpc(method, params ?? [], {
    timeoutMs: config.ROUTER_STARTUP_RPC_TIMEOUT_MS,
  }) }),
});
