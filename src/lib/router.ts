import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import { chain, NATIVE_TOKEN, normAddress } from './chain.js';
import { readRouterSettings } from './routerStartup.js';

export { pingRouterAbi } from './pingRouterAbi.js';

export const routerDomain = {
  name: 'PingRouter', version: '1', chainId: chain.id,
  verifyingContract: normAddress(config.ROUTER_ADDRESS),
} as const;

export const sendAuthTypes = { SendAuth: [
  { name: 'id', type: 'bytes32' }, { name: 'sender', type: 'address' },
  { name: 'recipient', type: 'address' }, { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] } as const;
export const escrowAuthTypes = { EscrowAuth: [
  { name: 'id', type: 'bytes32' }, { name: 'sender', type: 'address' },
  { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'claimTip', type: 'uint256' }, { name: 'expiresAt', type: 'uint64' },
  { name: 'deadline', type: 'uint256' },
] } as const;
export const claimAuthTypes = { ClaimAuth: [
  { name: 'id', type: 'bytes32' }, { name: 'recipient', type: 'address' },
  { name: 'relayer', type: 'address' }, { name: 'deadline', type: 'uint256' },
] } as const;

export type SendAuth = { id: Hex; sender: Address; recipient: Address; token: Address; amount: bigint; deadline: bigint };
export type EscrowAuth = { id: Hex; sender: Address; token: Address; amount: bigint; claimTip: bigint; expiresAt: bigint; deadline: bigint };
export type ClaimAuth = { id: Hex; recipient: Address; relayer: Address; deadline: bigint };

function signerAccount() {
  if (!config.ROUTER_SIGNER_KEY) throw new Error('Router signer is not configured.');
  return privateKeyToAccount(`0x${config.ROUTER_SIGNER_KEY}`);
}

// Explicit domain overrides allow the same signing functions to be cross-checked
// against a freshly deployed router in integration tests. HTTP callers cannot set them.
export function signSendAuth(auth: SendAuth, domain = routerDomain): Promise<Hex> {
  return signerAccount().signTypedData({ domain, types: sendAuthTypes, primaryType: 'SendAuth', message: auth });
}
export function signEscrowAuth(auth: EscrowAuth, domain = routerDomain): Promise<Hex> {
  return signerAccount().signTypedData({ domain, types: escrowAuthTypes, primaryType: 'EscrowAuth', message: auth });
}
export function signClaimAuth(auth: ClaimAuth, domain = routerDomain): Promise<Hex> {
  return signerAccount().signTypedData({ domain, types: claimAuthTypes, primaryType: 'ClaimAuth', message: auth });
}
export function getRelayerAccount() {
  if (!config.RELAYER_PRIVATE_KEY) throw new Error('Router relayer is not configured.');
  return privateKeyToAccount(`0x${config.RELAYER_PRIVATE_KEY}`);
}
export const newRouterId = (): Hex => `0x${randomBytes(32).toString('hex')}`;
export const getEscrowFee = async (): Promise<bigint> => (await readRouterSettings()).escrowFee;
export const isNativeRouterToken = (token: string): boolean => normAddress(token) === NATIVE_TOKEN;

export function serializeRouterAuth<T extends SendAuth | EscrowAuth | ClaimAuth>(auth: T) {
  return Object.fromEntries(Object.entries(auth).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])) as {
    [K in keyof T]: T[K] extends bigint ? string : T[K];
  };
}
