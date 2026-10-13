import { platform } from "@/platform";
import { safeReturnTo } from "@/auth/return-to";

const PENDING_KEY = "pingapp.pending-link.v1";
let pending: string | null = null;
let startup: Promise<void> | undefined;
let writes = Promise.resolve();
const listeners = new Set<() => void>();

/** Inspect the raw path before URL parsing can normalize traversal away. */
export function deepLinkPath(
  url: string,
  configuration: { host: string; scheme: string },
): string | null {
  if (/[\s\\]/.test(url) || /%(?![0-9a-f]{2})/i.test(url)) return null;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)(\?[^#]*)?$/i.exec(url);
  if (!match) return null;
  const [, scheme, authority, rawPath, search = ""] = match;
  try {
    const parsed = new URL(url);
    const https = scheme === "https" && authority === configuration.host;
    const custom = scheme === configuration.scheme && authority === "open";
    if ((!https && !custom) || parsed.username || parsed.password || parsed.port) return null;
    if (parsed.pathname !== rawPath || rawPath.includes("%")) return null;
    const path = rawPath + search;
    if (safeReturnTo(path) !== path) return null;
    if (!/^\/dashboard(?:\/|$)/.test(rawPath) && !/^\/claim\/[A-Za-z0-9]{10}$/.test(rawPath))
      return null;
    return path;
  } catch {
    return null;
  }
}

function storedPath(path: string | null): string | null {
  return path && deepLinkPath(`pingapp://open${path}`, { host: "", scheme: "pingapp" });
}

function publish(path: string | null) {
  pending = path;
  for (const listener of listeners) listener();
}

function enqueue(action: () => Promise<void>): Promise<void> {
  const next = writes.then(action);
  writes = next.catch(() => {});
  return next;
}

export const pendingDeepLink = {
  getSnapshot: () => pending,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  consume(path: string) {
    return enqueue(async () => {
      if (pending !== path) return;
      await platform.persistentStorage.remove(PENDING_KEY);
      if (pending === path) publish(null);
    });
  },
};

/** One listener per native JS process, including React StrictMode remounts. */
export function initializeDeepLinks(): Promise<void> {
  startup ??= (async () => {
    if (!platform.isNative) return;
    const configuration = await platform.appLinkConfiguration();
    publish(storedPath(await platform.persistentStorage.get(PENDING_KEY)));
    const receive = (url: string) =>
      enqueue(async () => {
        const path = deepLinkPath(url, configuration);
        if (path) {
          // Only a validated local destination lives in Preferences. No wallet,
          // credential, token or arbitrary incoming URL is persisted here.
          await platform.persistentStorage.set(PENDING_KEY, path);
          publish(path);
        }
        // A consumed Android task intent must not resurrect an old destination.
        await platform.acknowledgeAppUrl(url);
      });
    let receivedWarmLink = false;
    await platform.onAppUrlOpen(({ url }) => {
      receivedWarmLink = true;
      void receive(url).catch(() => {});
    });
    const launch = await platform.getLaunchUrl();
    if (launch && !receivedWarmLink) await receive(launch);
    await writes;
    if (pending)
      history.replaceState(history.state, "", `/login?returnTo=${encodeURIComponent(pending)}`);
  })();
  return startup;
}
