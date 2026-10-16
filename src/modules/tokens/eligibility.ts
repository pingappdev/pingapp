import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { audit } from '../../db/audit.js';
import { tokenEligibilityBlocks, tokens, type Token } from '../../db/schema.js';
import type { DbTransaction } from '../../db/tx.js';
import { chain, normAddress } from '../../lib/chain.js';
import { errors } from '../../lib/errors.js';

export type TokenAuthorizationStatus = 'not_operator_reviewed' | 'operator_blocked' | 'review_required';
export type TokenAuthorizationInfo = { status: TokenAuthorizationStatus; reviewRevision: string | null };

export function normalizeMultiplier(value: unknown): string | null {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) return null;
  const [rawInteger, rawFraction = ''] = text.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

export async function assertNewEscrowTokenEligible(tx: DbTransaction, address: string): Promise<Token> {
  const normalized = normAddress(address);
  const [token] = await tx.select().from(tokens).where(and(
    eq(tokens.address, normalized), eq(tokens.chainId, chain.id), eq(tokens.active, true),
  )).for('update').limit(1);
  if (!token) throw errors.unknownToken();
  const [block] = await tx.select({ source: tokenEligibilityBlocks.source }).from(tokenEligibilityBlocks)
    .where(eq(tokenEligibilityBlocks.tokenAddress, token.address)).limit(1);
  if (block) {
    const message = block.source === 'issuer_multiplier_change'
      ? 'New escrow authorizations for this token are paused while its unit-conversion metadata is reviewed.'
      : 'New escrow authorizations for this token are paused by the operator.';
    throw errors.conflict(message);
  }
  return token;
}

export async function tokenAuthorizationStatuses(addresses: string[]): Promise<Map<string, TokenAuthorizationInfo>> {
  const normalized = [...new Set(addresses.map((address) => normAddress(address)))];
  if (!normalized.length) return new Map();
  const rows = await db.select({
    address: tokenEligibilityBlocks.tokenAddress,
    source: tokenEligibilityBlocks.source,
    reviewRevision: tokenEligibilityBlocks.reviewRevision,
  })
    .from(tokenEligibilityBlocks).where(inArray(tokenEligibilityBlocks.tokenAddress, normalized));
  const blocks = new Map(rows.map((row) => [row.address, row]));
  return new Map(normalized.map((address) => [address,
    blocks.get(address)?.source === 'issuer_multiplier_change'
      ? { status: 'review_required' as const, reviewRevision: blocks.get(address)!.reviewRevision }
      : blocks.has(address)
        ? { status: 'operator_blocked' as const, reviewRevision: blocks.get(address)!.reviewRevision }
        : { status: 'not_operator_reviewed' as const, reviewRevision: null }]));
}

export async function blockTokenForNewAuthorizations(address: string, reason: string): Promise<void> {
  const normalized = normAddress(address);
  if (!reason.trim() || reason.trim().length > 500) throw errors.validation('Provide a reason of 1 to 500 characters.');
  await db.transaction(async (tx) => {
    const [token] = await tx.select().from(tokens).where(and(
      eq(tokens.address, normalized), eq(tokens.chainId, chain.id),
    )).for('update').limit(1);
    if (!token) throw errors.unknownToken();
    const observedMultiplier = token.kind === 'stock' && token.multiplierKnown
      ? normalizeMultiplier(token.multiplier)
      : null;
    const [existing] = await tx.select().from(tokenEligibilityBlocks)
      .where(eq(tokenEligibilityBlocks.tokenAddress, token.address)).for('update').limit(1);
    const sameBlock = existing?.source === 'operator' && existing.reason === reason &&
      existing.observedMultiplier === observedMultiplier;
    const reviewRevision = sameBlock ? existing.reviewRevision : randomUUID();
    await tx.insert(tokenEligibilityBlocks).values({ tokenAddress: token.address, chainId: token.chainId,
      source: 'operator', reason, observedMultiplier, reviewRevision })
      .onConflictDoUpdate({ target: tokenEligibilityBlocks.tokenAddress, set: {
        chainId: token.chainId, source: 'operator', reason, observedMultiplier, reviewRevision, updatedAt: new Date(),
      } });
    await audit('token_authorization_blocked', { data: { tokenAddress: token.address, reason, reviewRevision } }, tx);
  });
}

export async function unblockTokenForNewAuthorizations(
  address: string, reviewRevision: string, reviewedMultiplier?: string,
): Promise<void> {
  const normalized = normAddress(address);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewRevision)) {
    throw errors.validation('Provide the current review revision from the token eligibility list.');
  }
  await db.transaction(async (tx) => {
    const [token] = await tx.select().from(tokens).where(and(
      eq(tokens.address, normalized), eq(tokens.chainId, chain.id),
    )).for('update').limit(1);
    if (!token) throw errors.unknownToken();
    const [block] = await tx.select().from(tokenEligibilityBlocks)
      .where(eq(tokenEligibilityBlocks.tokenAddress, normalized)).for('update').limit(1);
    if (!block) throw errors.conflict('This token has no operator authorization block.');
    if (block.reviewRevision !== reviewRevision) {
      throw errors.conflict('The token block changed since it was reviewed. List eligibility again before clearing it.');
    }
    if (token.kind === 'stock' && token.multiplierKnown) {
      const supplied = normalizeMultiplier(reviewedMultiplier);
      const current = normalizeMultiplier(token.multiplier);
      const observed = normalizeMultiplier(block.observedMultiplier);
      if (!supplied || supplied !== current || observed !== current) {
        throw errors.conflict('Review the current issuer multiplier before clearing this token block.');
      }
    }
    await tx.delete(tokenEligibilityBlocks).where(eq(tokenEligibilityBlocks.tokenAddress, normalized));
    await audit('token_authorization_unblocked', { data: {
      tokenAddress: token.address, source: block.source, reviewRevision: block.reviewRevision,
    } }, tx);
  });
}
