import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/tokens/prices.js', () => ({ getPrices: vi.fn() }));

import { getPrices } from '../src/modules/tokens/prices.js';
import { assertMinAmount, getMinAmountRaw, type MinimumToken } from '../src/modules/tokens/minimum.js';
import { mulDecimalStrings } from '../src/lib/money.js';

const getPricesMock = vi.mocked(getPrices);

function token(overrides: Partial<MinimumToken> = {}): MinimumToken {
  return {
    address: '0x0000000000000000000000000000000000000001',
    decimals: 18,
    kind: 'native',
    symbol: 'ETH',
    ...overrides,
  };
}

function withPrice(tokenRow: MinimumToken, price: string | null): void {
  getPricesMock.mockResolvedValue(new Map([[tokenRow.address.toLowerCase(), price]]));
}

describe('minimum send amount', () => {
  beforeEach(() => getPricesMock.mockReset());

  it('rounds the $2 ETH minimum upward to six displayed decimals', async () => {
    const eth = token();
    withPrice(eth, '2700');
    await expect(getMinAmountRaw(eth)).resolves.toBe(741_000_000_000_000n);
  });

  it('computes the USDG minimum in its six token decimals', async () => {
    const usdg = token({ address: '0x0000000000000000000000000000000000000002', decimals: 6, kind: 'stable', symbol: 'USDG' });
    withPrice(usdg, '1');
    await expect(getMinAmountRaw(usdg)).resolves.toBe(2_000_000n);
  });

  it('uses multiplier-adjusted stock price with exact bigint arithmetic', async () => {
    const stock = token({ address: '0x0000000000000000000000000000000000000003', kind: 'stock', symbol: 'AAPL' });
    const adjustedPrice = mulDecimalStrings('337.21', '1.0011', 6);
    expect(adjustedPrice).toBe('337.580931');
    withPrice(stock, adjustedPrice);
    await expect(getMinAmountRaw(stock)).resolves.toBe(5_925_000_000_000_000n);
  });

  it('does not allow a stock token with no available price', async () => {
    const stock = token({ kind: 'stock', symbol: 'AAPL' });
    withPrice(stock, null);
    await expect(getMinAmountRaw(stock)).resolves.toBeNull();
  });

  it('uses the configured ETH fallback when ETH has no price', async () => {
    const eth = token();
    withPrice(eth, null);
    await expect(getMinAmountRaw(eth)).resolves.toBe(1_000_000_000_000_000n);
  });

  it('reports the unavailable-price error and the computed minimum details', async () => {
    const stock = token({ kind: 'stock', symbol: 'AAPL' });
    withPrice(stock, null);
    await expect(assertMinAmount(stock, 1n, { tolerancePct: 0 })).rejects.toMatchObject({
      code: 'AMOUNT_TOO_SMALL',
      details: { minAmount: null, symbol: 'AAPL', minUsd: '2' },
    });

    const eth = token();
    withPrice(eth, '2700');
    await expect(assertMinAmount(eth, 740_000_000_000_000n, { tolerancePct: 0 })).rejects.toMatchObject({
      code: 'AMOUNT_TOO_SMALL',
      message: 'The minimum is $2.00 (0.000741 ETH).',
    });
    await expect(assertMinAmount(eth, 666_900_000_000_000n, { tolerancePct: 10 })).resolves.toBeUndefined();
  });
});
