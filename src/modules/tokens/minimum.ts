import { parseUnits } from 'viem';
import { config } from '../../config.js';
import { errors } from '../../lib/errors.js';
import { formatAmount } from '../../lib/money.js';
import type { Token } from '../../db/schema.js';
import { getPrices } from './prices.js';

export type MinimumToken = Pick<Token, 'address' | 'decimals' | 'kind' | 'symbol'>;

type DecimalParts = { units: bigint; decimals: number };

function decimalParts(value: string): DecimalParts {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError('Expected a non-negative decimal string.');
  }
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(`${whole}${fraction}`), decimals: fraction.length };
}

function pow10(power: number): bigint {
  if (!Number.isSafeInteger(power) || power < 0 || power > 255) {
    throw new RangeError('Token decimals must be an integer from 0 through 255.');
  }
  return 10n ** BigInt(power);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function formatUsd(value: string): string {
  const { units, decimals } = decimalParts(value);
  const divisor = pow10(decimals);
  const centsNumerator = units * 100n;
  let cents = centsNumerator / divisor;
  if ((centsNumerator % divisor) * 2n >= divisor) cents += 1n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function minimumDisplay(raw: bigint, decimals: number): string {
  return formatAmount(raw, decimals);
}

export async function getMinAmountRaw(token: MinimumToken, knownPrice?: string | null): Promise<bigint | null> {
  if (!Number.isSafeInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
    throw new RangeError('Token decimals must be an integer from 0 through 255.');
  }

  const price = knownPrice === undefined
    ? (await getPrices()).get(token.address.toLowerCase()) ?? null
    : knownPrice;
  if (price === null) {
    return token.kind === 'native' || token.kind === 'wrapped'
      ? parseUnits(config.MIN_SEND_ETH_FALLBACK, 18)
      : null;
  }

  const usd = decimalParts(config.MIN_SEND_USD);
  const tokenPrice = decimalParts(price);
  if (tokenPrice.units === 0n) return null;

  // (USD / price) * 10^tokenDecimals, with decimal scales cancelling exactly.
  const numerator = usd.units * pow10(tokenPrice.decimals) * pow10(token.decimals);
  const denominator = tokenPrice.units * pow10(usd.decimals);
  const rawMinimum = ceilDiv(numerator, denominator);

  // The API displays at most six fractional digits. Make the raw guard match
  // that display by rounding the minimum upward to its smallest display unit.
  const displayDp = Math.min(6, token.decimals);
  const rawPerDisplayUnit = pow10(token.decimals - displayDp);
  return ceilDiv(rawMinimum, rawPerDisplayUnit) * rawPerDisplayUnit;
}

export async function assertMinAmount(
  token: MinimumToken,
  amountRaw: bigint,
  opts: { tolerancePct: number },
): Promise<void> {
  if (!Number.isSafeInteger(opts.tolerancePct) || opts.tolerancePct < 0 || opts.tolerancePct > 100) {
    throw new RangeError('Tolerance must be an integer from 0 through 100.');
  }

  const minRaw = await getMinAmountRaw(token);
  if (minRaw === null) {
    throw errors.amountTooSmall(
      "This token can't be sent right now because its price is unavailable.",
      { minAmount: null, symbol: token.symbol, minUsd: config.MIN_SEND_USD },
    );
  }

  if (amountRaw * 100n < minRaw * BigInt(100 - opts.tolerancePct)) {
    const minAmount = minimumDisplay(minRaw, token.decimals);
    throw errors.amountTooSmall(
      `The minimum is $${formatUsd(config.MIN_SEND_USD)} (${minAmount} ${token.symbol}).`,
      { minAmount, symbol: token.symbol, minUsd: config.MIN_SEND_USD },
    );
  }
}
