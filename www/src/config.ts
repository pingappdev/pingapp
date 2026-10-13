import { defineChain } from "viem";
import { config } from "./env";

export { config } from "./env";

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
  rpcUrls: { default: { http: [config.rpcUrl || selected.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: selected.explorerUrl } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: config.chainKey === "robinhood-testnet",
});

export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const explorerTx = (hash: string) => `${selected.explorerUrl}/tx/${hash}`;
export const explorerAddress = (address: string) => `${selected.explorerUrl}/address/${address}`;
