import { config } from '../config.js';
import type { Address } from 'viem';
import { chain, normAddress } from './chain.js';
import { pingRouterAbi } from './pingRouterAbi.js';
import { getRelayerAccount, getRouterSignerAddress } from './routerKeys.js';
import { routerStartupClient } from './viem.js';

type RouterSettings = { escrowFee: bigint; signerAddress?: Address };
type SigningReadiness = Readonly<{ address: Address; generation: number }>;
export type RouterStartupFailureCategory = 'rpc_unavailable' | 'chain_mismatch' | 'signer_mismatch' | 'configuration_error' | 'startup_error';
let settings: Promise<RouterSettings> | undefined;
let signingReadiness: SigningReadiness | undefined;
let readinessGeneration = 0;

export function stopRouterSigning(): void {
  readinessGeneration += 1;
  signingReadiness = undefined;
}

export function assertRouterSigningReady(): SigningReadiness {
  if (!signingReadiness) throw new Error('Router signing is unavailable until startup verification completes.');
  return signingReadiness;
}

export function routerStartupFailureCategory(error: unknown): RouterStartupFailureCategory {
  if (!(error instanceof Error)) return 'startup_error';
  const message = error.message;
  if (message.startsWith('Configured router RPC chain mismatch:')) return 'chain_mismatch';
  if (message === 'Configured router signer does not match the deployed router signer.') return 'signer_mismatch';
  if (error.name === 'AppError' && 'code' in error && error.code === 'UPSTREAM_UNAVAILABLE') return 'rpc_unavailable';
  if (/^(ROUTER_SIGNER_KEY|RELAYER_PRIVATE_KEY) is (not configured|invalid)\.$/.test(message)) return 'configuration_error';
  return 'startup_error';
}

export async function initializeRouter(): Promise<void> {
  stopRouterSigning();
  const generation = readinessGeneration;
  settings = undefined;
  if (!config.ROUTER_ENABLED) return;
  try {
    const verified = await readRouterSettings();
    if (generation !== readinessGeneration) return;
    if ((config.ROUTER_NEW_AUTHORIZATIONS_ENABLED || config.ROUTER_NEW_CLAIM_SIGNATURES_ENABLED) && verified.signerAddress) {
      signingReadiness = Object.freeze({ address: verified.signerAddress, generation });
    }
  } catch (error) {
    if (generation === readinessGeneration) stopRouterSigning();
    throw error;
  }
}

export function readRouterSettings(): Promise<RouterSettings> {
  if (!config.ROUTER_ENABLED) throw new Error('Router is disabled.');
  if (settings) return settings;
  const pending = (async () => {
    const address = normAddress(config.ROUTER_ADDRESS);
    const signingEnabled = config.ROUTER_NEW_AUTHORIZATIONS_ENABLED || config.ROUTER_NEW_CLAIM_SIGNATURES_ENABLED;
    const expectedSigner = signingEnabled ? getRouterSignerAddress() : undefined;
    const rpcChainId = await routerStartupClient.getChainId();
    if (rpcChainId !== chain.id) {
      throw new Error(`Configured router RPC chain mismatch: expected ${chain.id}, received ${rpcChainId}.`);
    }
    const [escrowFee, signer] = await Promise.all([
      routerStartupClient.readContract({ address, abi: pingRouterAbi, functionName: 'escrowFee' }),
      routerStartupClient.readContract({ address, abi: pingRouterAbi, functionName: 'signer' }),
    ]);
    if (expectedSigner) {
      if (normAddress(signer) !== normAddress(expectedSigner)) {
        throw new Error('Configured router signer does not match the deployed router signer.');
      }
    }
    if (config.ROUTER_NEW_CLAIM_SIGNATURES_ENABLED || config.ROUTER_RELAY_BROADCASTS_ENABLED) getRelayerAccount();
    return { escrowFee, ...(expectedSigner ? { signerAddress: expectedSigner } : {}) };
  })();
  let tracked: Promise<RouterSettings>;
  tracked = pending.catch((error: unknown) => {
    if (settings === tracked) settings = undefined;
    throw error;
  });
  settings = tracked;
  return tracked;
}
