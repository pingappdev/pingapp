import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { formatAmount, parseAmount, usdValue } from '../src/lib/money.js';

describe('token amount helpers', () => {
  it.each([
    ['123.456789', 6],
    ['1.000000000000000001', 18],
  ])('round-trips %s at %i decimals', (decimal, decimals) => {
    const raw = parseAmount(decimal, decimals);
    expect(formatAmount(raw, decimals)).toBe(decimal);
    expect(parseAmount(formatAmount(raw, decimals), decimals)).toBe(raw);
  });

  it('rejects excess precision and zero', () => {
    expect(() => parseAmount('1.0000001', 6)).toThrow(AppError);
    expect(() => parseAmount('0', 18)).toThrow(AppError);
  });

  it('calculates USD values to two decimals using half-up rounding', () => {
    expect(usdValue(1n, 0, '0.005')).toBe('0.01');
    expect(usdValue(1n, 0, '0.0049')).toBe('0.00');
    expect(usdValue(1000000n, 6, '1.25')).toBe('1.25');
    expect(usdValue(1000000n, 6, null)).toBeNull();
  });
});
