import type { FastifyPluginAsync } from 'fastify';
import type { Address } from 'viem';
import type { Token } from '../../db/schema.js';
import { checksum } from '../../lib/chain.js';
import { formatAmount } from '../../lib/money.js';
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
};

export default routes;
