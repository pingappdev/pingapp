// These pages are complete documents with their own runtime and stylesheet.
export const marketingPaths = new Set([
  "/",
  "/features",
  "/about",
  "/protocol",
  "/use-cases",
  "/guides",
  "/use-cases/private-payments",
  "/use-cases/receive-your-way",
  "/use-cases/card-in-control",
  "/use-cases/private-payroll",
  "/guides/phone-to-wallet",
  "/guides/wallet-ownership",
  "/guides/phone-identity",
  "/guides/evm-balances",
]);

// Preserve bookmarks and the existing dashboard's help links.
export const marketingAliases: Record<string, string> = {
  "/what-we-do": "/features",
  "/what-we-do/resolve": "/guides/phone-to-wallet",
  "/what-we-do/connect": "/guides/wallet-ownership",
  "/what-we-do/security": "/guides/wallet-ownership",
  "/who-we-are": "/about",
  "/case-studies": "/use-cases",
  "/insights": "/guides",
  "/insights/phone-to-wallet": "/guides/phone-to-wallet",
  "/insights/your-keys": "/guides/wallet-ownership",
  "/insights/safer-connections": "/guides/phone-identity",
};

export function normalizeMarketingPath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

export function isStandaloneMarketingPath(pathname: string) {
  const path = normalizeMarketingPath(pathname);
  return marketingPaths.has(path) || Object.hasOwn(marketingAliases, path);
}
