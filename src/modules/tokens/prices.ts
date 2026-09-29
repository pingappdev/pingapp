import { chain } from '../../lib/chain.js';
import { cached } from '../../lib/cache.js';
import { fetchJson } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { mulDecimalStrings } from '../../lib/money.js';
import { redis } from '../../lib/redis.js';
import { getActiveTokens } from './registry.js';

const LAST_PRICE_TTL_SEC = 7 * 24 * 60 * 60;
const TEN_TO_18 = 1_000_000_000_000_000_000n;

type DecimalParts = { units: bigint; decimals: number };
type CoinbaseResponse = { data?: { amount?: unknown } };
type KrakenResponse = { result?: Record<string, { c?: unknown[] }> };
type RhDeployment = { contractAddress?: unknown; chainId?: unknown };
type RhQuote = { bid?: unknown; ask?: unknown; deployments?: unknown };

function expandExponent(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) return value;
  const digits = `${match[1]}${match[2] ?? ''}`;
  const point = match[1].length + Number(match[3]);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${'0'.repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

function decimalParts(value: unknown): DecimalParts | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = expandExponent(String(value));
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 18) return null;
  return { units: BigInt(`${whole}${fraction}`), decimals: fraction.length };
}

function scaled18(parts: DecimalParts): bigint {
  return parts.units * (10n ** BigInt(18 - parts.decimals));
}

function format18(value: bigint): string {
  const whole = value / TEN_TO_18;
  const fraction = (value % TEN_TO_18).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function normalizedPrice(value: unknown): string | null {
  const parts = decimalParts(value);
  if (!parts || parts.units <= 0n) return null;
  const units18 = scaled18(parts);
  const outputUnits = units18 / 10n ** 12n;
  const whole = outputUnits / 1_000_000n;
  const fraction = (outputUnits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function quoteMid(bid: unknown, ask: unknown): string | null {
  const bidParts = decimalParts(bid);
  const askParts = decimalParts(ask);
  const hasBid = bidParts !== null && bidParts.units > 0n;
  const hasAsk = askParts !== null && askParts.units > 0n;
  if (!hasBid && !hasAsk) return null;
  if (!hasBid) return askParts ? format18(scaled18(askParts)) : null;
  if (!hasAsk) return bidParts ? format18(scaled18(bidParts)) : null;

  const bid18 = scaled18(bidParts!);
  const ask18 = scaled18(askParts!);
  return format18((bid18 + ask18) / 2n);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getEthUsd(): Promise<string | null> {
  return cached('prices:eth-usd', 60, async () => {
    try {
      const response = await fetchJson<CoinbaseResponse>('https://api.coinbase.com/v2/prices/ETH-USD/spot');
      const price = normalizedPrice(response.data?.amount);
      if (price) return price;
    } catch {
      // Try the documented public fallback below.
    }

    try {
      const response = await fetchJson<KrakenResponse>('https://api.kraken.com/0/public/Ticker?pair=ETHUSD');
      const firstPair = Object.values(response.result ?? {})[0];
      const price = normalizedPrice(firstPair?.c?.[0]);
      if (price) return price;
    } catch {
      // Both sources failed; callers can use their per-token last-known value.
    }

    logger.warn('ETH/USD price sources are unavailable');
    return null;
  });
}

export async function getStockPrices(): Promise<Map<string, { bidAskMid: string }>> {
  const result = await cached<Record<string, string>>('prices:stock', 20, async () => {
    try {
      const response = await fetchJson<{ quotes?: unknown }>('https://api.robinhood.com/rhj/prices');
      if (!Array.isArray(response.quotes)) throw new TypeError('Robinhood prices response has no quotes array.');
      const prices: Record<string, string> = {};
      for (const value of response.quotes) {
        if (!isRecord(value) || !Array.isArray(value.deployments)) continue;
        const mid = quoteMid(value.bid, value.ask);
        if (!mid) continue;
        for (const rawDeployment of value.deployments) {
          if (!isRecord(rawDeployment) || Number(rawDeployment.chainId) !== chain.id) continue;
          const address = rawDeployment.contractAddress;
          if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)) continue;
          prices[address.toLowerCase()] = mid;
        }
      }
      return prices;
    } catch (error) {
      logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'stock token prices unavailable');
      return {};
    }
  });
  return new Map(Object.entries(result).map(([address, bidAskMid]) => [address, { bidAskMid }]));
}

export async function getPrices(): Promise<Map<string, string | null>> {
  const activeTokens = await getActiveTokens();
  const [ethUsd, stockPrices] = await Promise.all([getEthUsd(), getStockPrices()]);
  const result = new Map<string, string | null>();
  const liveByAddress = new Map<string, string>();

  for (const token of activeTokens) {
    const address = token.address.toLowerCase();
    let livePrice: string | null = null;
    if (token.kind === 'native' || token.kind === 'wrapped') {
      livePrice = ethUsd;
    } else if (token.kind === 'stable') {
      livePrice = '1';
    } else if (token.kind === 'stock') {
      const quote = stockPrices.get(address);
      if (quote) {
        try {
          livePrice = normalizedPrice(mulDecimalStrings(quote.bidAskMid, token.multiplier, 6));
        } catch (error) {
          logger.warn({ address, errorType: error instanceof Error ? error.name : 'unknown' }, 'invalid stock token price data');
        }
      }
    }
    if (livePrice) liveByAddress.set(address, livePrice);
  }

  await Promise.all([...liveByAddress].map(async ([address, price]) => {
    try {
      await redis.set(`px:last:${address}`, price, 'EX', LAST_PRICE_TTL_SEC);
    } catch (error) {
      logger.warn({ address, errorType: error instanceof Error ? error.name : 'unknown' }, 'failed to save last-known token price');
    }
  }));

  await Promise.all(activeTokens.map(async (token) => {
    const address = token.address.toLowerCase();
    const livePrice = liveByAddress.get(address);
    if (livePrice) {
      result.set(address, livePrice);
      return;
    }
    try {
      const lastPrice = await redis.get(`px:last:${address}`);
      result.set(address, lastPrice === null ? null : normalizedPrice(lastPrice));
    } catch (error) {
      logger.warn({ address, errorType: error instanceof Error ? error.name : 'unknown' }, 'failed to read last-known token price');
      result.set(address, null);
    }
  }));

  return result;
}
