// Keep API/session configuration independent of the wallet libraries.
type ChainKey = "robinhood" | "robinhood-testnet";

function requiredEnv(name: "VITE_API_URL" | "VITE_APP_URL" | "VITE_CHAIN") {
  const value = import.meta.env[name]?.trim();
  if (!value && import.meta.env.DEV) {
    throw new Error(`Missing ${name}. Set it in docs/deploy/frontend.env.dev.`);
  }
  return value ?? "";
}

const chainKey = requiredEnv("VITE_CHAIN");
if (chainKey && chainKey !== "robinhood" && chainKey !== "robinhood-testnet") {
  throw new Error(`Unsupported VITE_CHAIN: ${chainKey}`);
}

export const config = {
  apiUrl: requiredEnv("VITE_API_URL"),
  appUrl: requiredEnv("VITE_APP_URL"),
  chainKey: (chainKey || "robinhood-testnet") as ChainKey,
  rpcUrl: import.meta.env.VITE_RPC_URL?.trim() || "",
  reownProjectId: import.meta.env.VITE_REOWN_PROJECT_ID?.trim() ?? "",
};
