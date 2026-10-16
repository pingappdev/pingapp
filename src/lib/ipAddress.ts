import { isIP } from 'node:net';

function parseIpv6(value: string): number[] | null {
  let input = value.toLowerCase();
  const lastColon = input.lastIndexOf(':');
  if (input.includes('.') && lastColon >= 0) {
    const ipv4 = input.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    input = `${input.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const compressed = input.includes('::');
  const halves = compressed ? input.split('::') : [input];
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = compressed && halves[1] ? halves[1].split(':') : [];
  const parseWord = (word: string) => /^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : null;
  const leftWords = left.map(parseWord), rightWords = right.map(parseWord);
  if ([...leftWords, ...rightWords].some((word) => word === null)) return null;
  const missing = 8 - leftWords.length - rightWords.length;
  if (compressed ? missing < 1 : missing !== 0) return null;
  return [...leftWords as number[], ...Array(missing).fill(0), ...rightWords as number[]];
}

export function normalizeIpAddress(input: string): string | null {
  let value = input.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (!value || value.includes('%')) return null;
  if (isIP(value) === 4) return value.split('.').map((part) => String(Number(part))).join('.');
  if (isIP(value) !== 6) return null;

  const words = parseIpv6(value);
  if (!words) return null;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const first = words[6], second = words[7];
    return `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
  }

  let bestStart = -1, bestLength = 1;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - index > bestLength) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const hex = words.map((word) => word.toString(16));
  if (bestStart < 0) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

function headerValues(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null;
  const entries = (Array.isArray(value) ? value : [value]).flatMap((part) => part.split(','));
  if (!entries.length || entries.some((entry) => !entry.trim())) return null;
  const normalized = entries.map((entry) => normalizeIpAddress(entry));
  return normalized.every((entry): entry is string => entry !== null) ? normalized : null;
}

export function resolveClientIp(
  peerAddress: string | undefined,
  headers: { 'cf-connecting-ip'?: string | string[]; 'x-forwarded-for'?: string | string[] },
  trustedPeers: readonly string[],
): string {
  const peer = peerAddress ? normalizeIpAddress(peerAddress) : null;
  if (!peer) return 'unknown';
  const trusted = new Set(trustedPeers);
  if (!trusted.has(peer)) return peer;

  const cloudflare = headerValues(headers['cf-connecting-ip']);
  if (cloudflare?.length === 1) return cloudflare[0];

  const forwarded = headerValues(headers['x-forwarded-for']);
  if (!forwarded) return peer;
  let current = peer;
  for (let index = forwarded.length - 1; index >= 0 && trusted.has(current); index -= 1) {
    current = forwarded[index];
  }
  return current;
}
