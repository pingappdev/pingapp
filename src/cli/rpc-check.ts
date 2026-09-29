import { chain } from '../lib/chain.js';
import { checkRpcEndpoints } from '../lib/rpcPool.js';

const checks = await checkRpcEndpoints();
for (const check of checks) {
  console.log(`${check.id}: chainId=${check.chainId ?? 'unavailable'}`);
  if (check.id === 'public') {
    console.log(`public latestBlock=${check.latestBlock ?? 'unavailable'}`);
    console.log(`multicall3 code=${check.multicall3Code === null || check.multicall3Code === undefined ? 'unavailable' : check.multicall3Code ? 'present' : 'absent'}`);
    if (chain.isTestnet) console.log(`testnet USDC decimals=${check.usdcDecimals ?? 'unavailable'}`);
  }
}

if (!checks.some((check) => check.chainId !== null)) process.exitCode = 1;
