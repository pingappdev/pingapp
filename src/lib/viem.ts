import { createPublicClient, custom } from 'viem';
import { viemChain } from './chain.js';
import { rpc } from './rpcPool.js';

export const publicClient = createPublicClient({
  chain: viemChain,
  transport: custom({ request: ({ method, params }) => rpc(method, params ?? []) }),
  batch: { multicall: true },
});
