import { randomBytes } from 'node:crypto';
import { hashTypedData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import { chain, isAddress, NATIVE_TOKEN, normAddress } from './chain.js';
import { assertRouterSigningReady, readRouterSettings } from './routerStartup.js';

export { getRelayerAccount, getRouterSignerAddress } from './routerKeys.js';

export { pingRouterAbi } from './pingRouterAbi.js';

export const routerDomain = Object.freeze({
  name: 'PingRouter', version: '1', chainId: chain.id,
  verifyingContract: normAddress(config.ROUTER_ADDRESS),
} as const);

function freezeTypedDataTypes<T extends Record<string, readonly Readonly<{ name: string; type: string }>[]>>(value: T): Readonly<T> {
  for (const fields of Object.values(value)) {
    for (const field of fields) Object.freeze(field);
    Object.freeze(fields);
  }
  return Object.freeze(value);
}

export const sendAuthTypes = freezeTypedDataTypes({ SendAuth: [
  { name: 'id', type: 'bytes32' }, { name: 'sender', type: 'address' },
  { name: 'recipient', type: 'address' }, { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] } as const);
export const escrowAuthTypes = freezeTypedDataTypes({ EscrowAuth: [
  { name: 'id', type: 'bytes32' }, { name: 'sender', type: 'address' },
  { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'claimTip', type: 'uint256' }, { name: 'expiresAt', type: 'uint64' },
  { name: 'deadline', type: 'uint256' },
] } as const);
export const claimAuthTypes = freezeTypedDataTypes({ ClaimAuth: [
  { name: 'id', type: 'bytes32' }, { name: 'recipient', type: 'address' },
  { name: 'relayer', type: 'address' }, { name: 'deadline', type: 'uint256' },
] } as const);

export type SendAuth = { id: Hex; sender: Address; recipient: Address; token: Address; amount: bigint; deadline: bigint };
export type EscrowAuth = { id: Hex; sender: Address; token: Address; amount: bigint; claimTip: bigint; expiresAt: bigint; deadline: bigint };
export type ClaimAuth = { id: Hex; recipient: Address; relayer: Address; deadline: bigint };

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_CLAIM_TIP = 1_000_000_000_000_000n;
const MIN_ESCROW_DURATION_SECONDS = 86_400n;
const MAX_ESCROW_DURATION_SECONDS = 60n * MIN_ESCROW_DURATION_SECONDS;
const MAX_CLAIM_AUTH_TTL_SECONDS = 600;

function assertId(id: string): void {
  if (!/^0x[0-9a-f]{64}$/i.test(id) || /^0x0{64}$/i.test(id)) throw new Error('Router authorization id is invalid.');
}

function assertAddress(value: string, field: string): void {
  if (!isAddress(value)) throw new Error(`Router authorization ${field} is invalid.`);
}

function assertDeadline(deadline: bigint, maxTtlSeconds: number): void {
  if (typeof deadline !== 'bigint') throw new Error('Router authorization deadline is invalid.');
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + BigInt(maxTtlSeconds)) {
    throw new Error('Router authorization deadline is outside the supported window.');
  }
}

function assertSendAuth(auth: SendAuth): void {
  assertId(auth.id);
  assertAddress(auth.sender, 'sender');
  assertAddress(auth.recipient, 'recipient');
  assertAddress(auth.token, 'token');
  if (normAddress(auth.recipient) === normAddress(auth.sender) || normAddress(auth.recipient) === normAddress(config.ROUTER_ADDRESS)) {
    throw new Error('Router authorization recipient is not allowed.');
  }
  if (typeof auth.amount !== 'bigint' || auth.amount <= 0n || auth.amount > MAX_UINT256) {
    throw new Error('Router authorization amount is invalid.');
  }
  assertDeadline(auth.deadline, Math.min(config.ROUTER_AUTH_TTL_SECONDS, 600));
}

function assertEscrowAuth(auth: EscrowAuth): void {
  assertId(auth.id);
  assertAddress(auth.sender, 'sender');
  assertAddress(auth.token, 'token');
  if (typeof auth.amount !== 'bigint' || auth.amount <= 0n || auth.amount > MAX_UINT256) {
    throw new Error('Router authorization amount is invalid.');
  }
  if (typeof auth.claimTip !== 'bigint' || auth.claimTip < 0n || auth.claimTip > MAX_CLAIM_TIP) {
    throw new Error('Router authorization claim tip is invalid.');
  }
  if (typeof auth.expiresAt !== 'bigint' || auth.expiresAt <= 0n || auth.expiresAt > MAX_UINT64) {
    throw new Error('Router authorization expiry is invalid.');
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (auth.expiresAt < now + MIN_ESCROW_DURATION_SECONDS || auth.expiresAt > now + MAX_ESCROW_DURATION_SECONDS) {
    throw new Error('Router authorization expiry is outside the supported 1-to-60-day window.');
  }
  assertDeadline(auth.deadline, Math.min(config.ROUTER_AUTH_TTL_SECONDS, 600));
  if (auth.deadline >= auth.expiresAt) throw new Error('Router authorization deadline must precede escrow expiry.');
}

function assertClaimAuth(auth: ClaimAuth): void {
  assertId(auth.id);
  assertAddress(auth.recipient, 'recipient');
  if (normAddress(auth.recipient) === normAddress(config.ROUTER_ADDRESS)) {
    throw new Error('Router authorization recipient is not allowed.');
  }
  assertAddress(auth.relayer, 'relayer');
  assertDeadline(auth.deadline, MAX_CLAIM_AUTH_TTL_SECONDS);
}

function assertSigningEnabled(operation: 'authorizations' | 'claim-signatures') {
  if (!config.ROUTER_ENABLED) throw new Error('Router signing is disabled.');
  const enabled = operation === 'authorizations'
    ? config.ROUTER_NEW_AUTHORIZATIONS_ENABLED
    : config.ROUTER_NEW_CLAIM_SIGNATURES_ENABLED;
  if (!enabled) throw new Error(`New router ${operation} are disabled.`);
  return assertRouterSigningReady();
}

function privateSigner(expected: ReturnType<typeof assertRouterSigningReady>) {
  const current = assertRouterSigningReady();
  if (current.generation !== expected.generation) {
    throw new Error('Router signing readiness changed during the request.');
  }
  const key = process.env.ROUTER_SIGNER_KEY;
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) throw new Error('ROUTER_SIGNER_KEY is not configured.');
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(`0x${key}`);
  } catch {
    throw new Error('ROUTER_SIGNER_KEY is invalid.');
  }
  if (normAddress(account.address) !== normAddress(expected.address)) {
    throw new Error('Configured router signer changed after startup verification.');
  }
  return account;
}

export async function signSendAuth(auth: SendAuth): Promise<Hex> {
  const readiness = assertSigningEnabled('authorizations');
  assertSendAuth(auth);
  const signature = await privateSigner(readiness).signTypedData({ domain: routerDomain, types: sendAuthTypes, primaryType: 'SendAuth', message: auth });
  const current = assertSigningEnabled('authorizations');
  if (current.generation !== readiness.generation) throw new Error('Router signing readiness changed during the request.');
  return signature;
}
export async function signEscrowAuth(auth: EscrowAuth): Promise<Hex> {
  const readiness = assertSigningEnabled('authorizations');
  assertEscrowAuth(auth);
  const signature = await privateSigner(readiness).signTypedData({ domain: routerDomain, types: escrowAuthTypes, primaryType: 'EscrowAuth', message: auth });
  const current = assertSigningEnabled('authorizations');
  if (current.generation !== readiness.generation) throw new Error('Router signing readiness changed during the request.');
  return signature;
}
export async function signClaimAuth(auth: ClaimAuth): Promise<Hex> {
  const readiness = assertSigningEnabled('claim-signatures');
  assertClaimAuth(auth);
  const signature = await privateSigner(readiness).signTypedData({ domain: routerDomain, types: claimAuthTypes, primaryType: 'ClaimAuth', message: auth });
  const current = assertSigningEnabled('claim-signatures');
  if (current.generation !== readiness.generation) throw new Error('Router signing readiness changed during the request.');
  return signature;
}
export function hashClaimAuth(auth: ClaimAuth): Hex {
  return hashTypedData({ domain: routerDomain, types: claimAuthTypes, primaryType: 'ClaimAuth', message: auth });
}
export const newRouterId = (): Hex => `0x${randomBytes(32).toString('hex')}`;
export const getEscrowFee = async (): Promise<bigint> => (await readRouterSettings()).escrowFee;
export const isNativeRouterToken = (token: string): boolean => normAddress(token) === NATIVE_TOKEN;

export function serializeRouterAuth<T extends SendAuth | EscrowAuth | ClaimAuth>(auth: T) {
  return Object.fromEntries(Object.entries(auth).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])) as {
    [K in keyof T]: T[K] extends bigint ? string : T[K];
  };
}
