import { formatUnits, parseUnits } from 'viem';
import { errors } from './errors.js';

function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError('Decimals must be a non-negative integer.');
  }
}

function rawInteger(raw: bigint | string): bigint {
  if (typeof raw === 'string' && !/^-?\d+$/.test(raw)) {
    throw new TypeError('Raw amount must be an integer string.');
  }
  return typeof raw === 'bigint' ? raw : BigInt(raw);
}

export function parseAmount(decimal: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (!/^\d+(?:\.\d+)?$/.test(decimal)) {
    throw errors.invalidAmount();
  }

  const fraction = decimal.split('.')[1] ?? '';
  if (fraction.length > decimals) {
    throw errors.invalidAmount();
  }

  try {
    const amount = parseUnits(decimal, decimals);
    if (amount <= 0n) {
      throw errors.invalidAmount();
    }
    return amount;
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') {
      throw error;
    }
    throw errors.invalidAmount();
  }
}

export function formatAmount(raw: bigint | string, decimals: number): string {
  assertDecimals(decimals);
  const formatted = formatUnits(rawInteger(raw), decimals);
  if (!formatted.includes('.')) {
    return formatted;
  }

  const trimmed = formatted.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

export function usdValue(raw: bigint | string, decimals: number, priceUsd: string | null): string | null {
  if (priceUsd === null) {
    return null;
  }

  assertDecimals(decimals);
  if (!/^\d+(?:\.\d+)?$/.test(priceUsd)) {
    throw new TypeError('USD price must be a non-negative decimal string.');
  }

  const priceParts = priceUsd.split('.');
  const priceScale = priceParts[1]?.length ?? 0;
  const priceUnits = BigInt(priceParts.join(''));
  const rawAmount = rawInteger(raw);
  const numerator = rawAmount * priceUnits * 100n;
  const denominator = 10n ** BigInt(decimals + priceScale);
  const sign = numerator < 0n ? -1n : 1n;
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  let cents = absoluteNumerator / denominator;
  const remainder = absoluteNumerator % denominator;
  if (remainder * 2n >= denominator) {
    cents += 1n;
  }
  cents *= sign;

  const absoluteCents = cents < 0n ? -cents : cents;
  const dollars = absoluteCents / 100n;
  const centsPart = (absoluteCents % 100n).toString().padStart(2, '0');
  return `${cents < 0n ? '-' : ''}${dollars}.${centsPart}`;
}
