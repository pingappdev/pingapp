import { defineChain } from "viem";

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
  // FE-04 needs this before it can enable wallet sign-in.
  reownProjectId: import.meta.env.VITE_REOWN_PROJECT_ID?.trim() ?? "",
};

const chainPresets = {
  robinhood: {
    id: 4663,
    name: "Robinhood Chain",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
  },
  "robinhood-testnet": {
    id: 46630,
    name: "Robinhood Chain Testnet",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  },
} as const;

const selected = chainPresets[config.chainKey];

export const chain = defineChain({
  id: selected.id,
  name: selected.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [selected.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: selected.explorerUrl } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: config.chainKey === "robinhood-testnet",
});

export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const explorerTx = (hash: string) => `${selected.explorerUrl}/tx/${hash}`;
export const explorerAddress = (address: string) => `${selected.explorerUrl}/address/${address}`;
