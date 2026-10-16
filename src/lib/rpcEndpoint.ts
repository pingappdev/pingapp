export function rpcEndpointOrigin(value: string): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function rpcEndpointIdentity(value: string): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) return null;
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

export function rpcEndpointSecrets(value: string): string[] {
  try {
    const url = new URL(value);
    const secrets = new Set<string>();
    const parts = [
      ...url.pathname.split('/'),
      ...[...url.searchParams.entries()].flatMap(([key, part]) => [key, part]),
    ].filter((part) => part.length > 0);
    for (const part of parts) {
      let decoded = part;
      // URL parsing decodes query values but not path segments. Cover a second
      // encoded layer as some providers accept percent-encoded project keys.
      for (let depth = 0; depth < 2; depth += 1) {
        secrets.add(decoded);
        secrets.add(encodeURIComponent(decoded));
        secrets.add(new URLSearchParams([['value', decoded]]).toString().slice('value='.length));
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch {
          break;
        }
      }
    }
    return [...secrets].sort((left, right) => right.length - left.length);
  } catch {
    return [];
  }
}
