import { and, eq, gt } from 'drizzle-orm';
import { isAddress, type Address, type Hex } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { audit } from '../../db/audit.js';
import { sessions, users } from '../../db/schema.js';
import { chain } from '../../lib/chain.js';
import { randomCode, randomToken, sha256Hex } from '../../lib/crypto.js';
import { AppError, errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import { publicClient } from '../../lib/viem.js';

const INVALID_MESSAGE = 'We could not verify your wallet signature. Please try again.';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const FRESH_MS = 10 * 60 * 1000;

export const LOGIN_STATEMENT = 'Sign in to PingApp. This only proves you own this wallet. It costs no gas and moves no funds.';
export const REAUTH_STATEMENT = 'Confirm a sensitive PingApp action.';

export type SiweDependencies = {
  consumeNonce: (nonce: string) => Promise<number>;
  verifySignature: (message: string, signature: Hex) => Promise<boolean>;
  allowedDomains: readonly string[];
  allowedOrigins: readonly string[];
  chainId: number;
  now: () => Date;
};

const liveDependencies: SiweDependencies = {
  consumeNonce: (nonce) => redis.del(`siwe:nonce:${nonce}`),
  verifySignature: (message, signature) => publicClient.verifySiweMessage({ message, signature }),
  allowedDomains: config.SIWE_ALLOWED_DOMAINS,
  allowedOrigins: config.CORS_ORIGINS,
  chainId: chain.id,
  now: () => new Date(),
};

function invalid(check: string): never {
  logger.warn({ check }, 'SIWE verification rejected');
  throw new AppError('SIWE_INVALID', 401, INVALID_MESSAGE);
}

export async function createNonce(): Promise<string> {
  const nonce = randomCode(24);
  await redis.set(`siwe:nonce:${nonce}`, '1', 'EX', 300);
  return nonce;
}

export async function verifySiwe(
  message: string,
  signature: Hex,
  options: { expectedAddress?: string; expectedStatement?: string } = {},
  dependencies: SiweDependencies = liveDependencies,
): Promise<Address> {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    invalid('parse');
  }
  if (!parsed.domain || !parsed.address || !parsed.uri || !parsed.nonce ||
      !parsed.issuedAt || !parsed.version || !parsed.chainId ||
      !isAddress(parsed.address) || !/^[A-Za-z0-9]{16,}$/.test(parsed.nonce)) {
    invalid('required_fields');
  }
  if (!dependencies.allowedDomains.includes(parsed.domain)) invalid('domain');

  let origin: string;
  try {
    const uri = new URL(parsed.uri);
    if (!['http:', 'https:'].includes(uri.protocol)) invalid('uri_scheme');
    origin = uri.origin;
  } catch {
    invalid('uri');
  }
  if (!dependencies.allowedOrigins.includes(origin)) invalid('uri_origin');
  if (parsed.chainId !== dependencies.chainId) invalid('chain');
  if (parsed.version !== '1') invalid('version');
  if (options.expectedStatement !== undefined && parsed.statement !== options.expectedStatement) invalid('statement');

  const nowMs = dependencies.now().getTime();
  const issuedMs = parsed.issuedAt.getTime();
  if (!Number.isFinite(issuedMs) || issuedMs > nowMs + 60_000 || issuedMs < nowMs - 600_000) invalid('issued_at');
  if (parsed.expirationTime && (!Number.isFinite(parsed.expirationTime.getTime()) || parsed.expirationTime.getTime() <= nowMs)) invalid('expiration');
  if (parsed.notBefore && (!Number.isFinite(parsed.notBefore.getTime()) || parsed.notBefore.getTime() > nowMs)) invalid('not_before');

  // The single-use claim happens before signature verification so concurrent replays
  // cannot both reach the verifier and create sessions.
  const consumed = await dependencies.consumeNonce(parsed.nonce);
  if (consumed !== 1) invalid('nonce');

  let verified: boolean;
  try {
    verified = await dependencies.verifySignature(message, signature);
  } catch (error) {
    logger.error({ err: error }, 'SIWE signature verifier unavailable');
    throw errors.upstreamUnavailable();
  }
  if (!verified) invalid('signature');
  if (options.expectedAddress && parsed.address.toLowerCase() !== options.expectedAddress.toLowerCase()) invalid('expected_address');
  return parsed.address;
}

export async function login(address: Address, meta: { userAgent?: string; ipHash?: string }): Promise<{ token: string; user: { id: string; address: string }; sessionId: string }> {
  const now = new Date();
  const token = randomToken();
  const result = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({
      address: address.toLowerCase(),
      lastLoginAt: now,
    }).onConflictDoUpdate({
      target: users.address,
      set: { lastLoginAt: now },
    }).returning({ id: users.id, address: users.address });
    const [session] = await tx.insert(sessions).values({
      userId: user.id,
      tokenHash: sha256Hex(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_MS),
      freshUntil: new Date(now.getTime() + FRESH_MS),
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      ipHash: meta.ipHash ?? null,
    }).returning({ id: sessions.id });
    await audit('login', { userId: user.id, ipHash: meta.ipHash }, tx);
    return { user, sessionId: session.id };
  });
  return { token, ...result };
}

export async function refreshFreshAuth(sessionId: string, userId: string, ipHash?: string): Promise<Date> {
  const freshUntil = new Date(Date.now() + FRESH_MS);
  await db.transaction(async (tx) => {
    const [updated] = await tx.update(sessions).set({ freshUntil })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
      .returning({ id: sessions.id });
    if (!updated) throw errors.unauthenticated();
    await audit('reauth', { userId, ipHash }, tx);
  });
  return freshUntil;
}
