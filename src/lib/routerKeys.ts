import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

function accountFromEnvironment(name: 'ROUTER_SIGNER_KEY' | 'RELAYER_PRIVATE_KEY') {
  const key = process.env[name];
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) throw new Error(`${name} is not configured.`);
  try {
    return privateKeyToAccount(`0x${key}`);
  } catch {
    throw new Error(`${name} is invalid.`);
  }
}

export function getRouterSignerAddress(): Address {
  return accountFromEnvironment('ROUTER_SIGNER_KEY').address;
}

export function getRelayerAccount() {
  return accountFromEnvironment('RELAYER_PRIVATE_KEY');
}
