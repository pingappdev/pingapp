import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import { normAddress } from './chain.js';
import { pingRouterAbi } from './pingRouterAbi.js';
import { publicClient } from './viem.js';

let settings: Promise<{ escrowFee: bigint }> | undefined;

export async function initializeRouter(): Promise<void> {
  if (config.ROUTER_ENABLED) await readRouterSettings();
}

export function readRouterSettings(): Promise<{ escrowFee: bigint }> {
  if (!config.ROUTER_ENABLED) throw new Error('Router is disabled.');
  settings ??= (async () => {
    const address = normAddress(config.ROUTER_ADDRESS);
    const [escrowFee, signer] = await Promise.all([
      publicClient.readContract({ address, abi: pingRouterAbi, functionName: 'escrowFee' }),
      publicClient.readContract({ address, abi: pingRouterAbi, functionName: 'signer' }),
    ]);
    const account = privateKeyToAccount(`0x${config.ROUTER_SIGNER_KEY}`);
    // Validate the relayer key too, without logging key material.
    privateKeyToAccount(`0x${config.RELAYER_PRIVATE_KEY}`);
    if (normAddress(signer) !== normAddress(account.address)) {
      throw new Error('Configured router signer does not match ROUTER_SIGNER_KEY.');
    }
    return { escrowFee };
  })().catch((error: unknown) => { settings = undefined; throw error; });
  return settings;
}
