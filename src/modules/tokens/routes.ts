import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Address } from 'viem';
import type { Token } from '../../db/schema.js';
import { checksum } from '../../lib/chain.js';
import { cached, invalidate } from '../../lib/cache.js';
import { AppError, errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatAmount } from '../../lib/money.js';
import { consume, limits } from '../../lib/rateLimit.js';
import { requireAuth } from '../../plugins/auth.js';
import { getBalances } from './balances.js';
import { getMinAmountRaw } from './minimum.js';
import { getPrices } from './prices.js';
import { ensureTokensSeeded, getActiveTokens } from './registry.js';

type TokenKind = 'native' | 'stable' | 'wrapped' | 'stock';
export type TokenDto = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: TokenKind;
  logoUrl: string | null;
  priceUsd: string | null;
  minAmount: string | null;
};

export function toTokenDto(row: Token, price: string | null, minRaw: bigint | null): TokenDto {
  return {
    address: checksum(row.address),
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    kind: row.kind as TokenKind,
    logoUrl: row.logoUrl,
    priceUsd: price,
    minAmount: minRaw === null ? null : formatAmount(minRaw, row.decimals),
  };
}

const balanceQuerySchema = z.object({ refresh: z.literal('1').optional() }).strict();

const routes: FastifyPluginAsync = async (app) => {
  await ensureTokensSeeded();

  app.get('/tokens', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=30');
    const rows = await getActiveTokens();
    const prices = await getPrices();
    const items = await Promise.all(rows.map(async (row) => {
      const price = prices.get(row.address.toLowerCase()) ?? null;
      const minRaw = await getMinAmountRaw(row, price);
      return toTokenDto(row, price, minRaw);
    }));
    return { items };
  });

  app.get('/wallet/balances', {
    preHandler: requireAuth,
    schema: { querystring: balanceQuerySchema },
  }, async (request) => {
    const { refresh } = request.query as z.infer<typeof balanceQuerySchema>;
    const address = checksum(request.user!.address);
    const cacheKey = `bal:${address.toLowerCase()}`;

    if (refresh === '1') {
      try {
        await consume(limits.balancesRefresh, request.user!.id);
        await invalidate(cacheKey);
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'RATE_LIMITED')) throw error;
        // A throttled refresh uses the existing per-wallet cache entry.
      }
    }

    try {
      return await cached(cacheKey, 15, async () => ({
        address,
        updatedAt: new Date().toISOString(),
        ...await getBalances(address),
      }));
    } catch (error) {
      logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'wallet balances unavailable');
      throw errors.upstreamUnavailable();
    }
  });
};

export default routes;
