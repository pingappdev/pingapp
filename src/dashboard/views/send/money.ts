import { formatUnits, parseUnits } from "viem";
import type { Token } from "../../../api/types";

export function rawAmount(value: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  if ((value.split(".")[1]?.length ?? 0) > decimals) return null;
  try {
    return parseUnits(value, decimals);
  } catch {
    return null;
  }
}

export function usdForRaw(raw: bigint, token: Token): string | null {
  const price = token.priceUsd;
  if (!price || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(price)) return null;
  const fraction = price.split(".")[1]?.length ?? 0;
  const priceInteger = BigInt(price.replace(".", ""));
  return formatUnits((raw * priceInteger) / 10n ** BigInt(token.decimals), fraction);
}

export function sendMinimum(token: Token, minSendUsd: string): string {
  return `The minimum is $${minSendUsd} (${token.minAmount} ${token.symbol}).`;
}
