import { defineChain, getAddress, isAddress as viemIsAddress, zeroAddress, type Address } from 'viem';
import { config } from '../config.js';

export const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;

export type ChainKey = 'robinhood' | 'robinhood-testnet';
export type Preset = {
  key: ChainKey;
  id: number;
  name: string;
  isTestnet: boolean;
  explorerUrl: string;
  publicRpcUrl: string;
  alchemyUrl: (key: string) => string;
  multicall3: Address | null;
  wellKnownTokens: {
    address: Address;
    symbol: string;
    name: string;
    decimals: number;
    kind: 'stable' | 'wrapped';
    sort: number;
    logoUrl?: string;
  }[];
};

const canonicalMulticall3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

const presets: Record<ChainKey, Preset> = {
  robinhood: {
    key: 'robinhood',
    id: 4663,
    name: 'Robinhood Chain',
    isTestnet: false,
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    alchemyUrl: (key) => `https://robinhood-mainnet.g.alchemy.com/v2/${key}`,
    multicall3: canonicalMulticall3,
    wellKnownTokens: [
      { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'USDG', decimals: 6, kind: 'stable', sort: 10 },
      { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, kind: 'wrapped', sort: 20 },
    ],
  },
  'robinhood-testnet': {
    key: 'robinhood-testnet',
    id: 46630,
    name: 'Robinhood Chain Testnet',
    isTestnet: true,
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    publicRpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    alchemyUrl: (key) => `https://robinhood-testnet.g.alchemy.com/v2/${key}`,
    // Verified on the testnet RPC during BE-04.
    multicall3: canonicalMulticall3,
    wellKnownTokens: [
      { address: '0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5', symbol: 'USDC', name: 'USD Coin', decimals: 6, kind: 'stable', sort: 10 },
    ],
  },
};

const selected = presets[config.CHAIN];
export const chain: Preset = Object.freeze({ ...selected, publicRpcUrl: config.PUBLIC_RPC_URL });

export const viemChain = defineChain({
  id: chain.id,
  name: chain.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [chain.publicRpcUrl] } },
  blockExplorers: { default: { name: 'Blockscout', url: chain.explorerUrl } },
  ...(chain.multicall3 ? { contracts: { multicall3: { address: chain.multicall3 } } } : {}),
  testnet: chain.isTestnet,
});

export const explorerTx = (hash: string) => `${chain.explorerUrl}/tx/${hash}`;
export const explorerAddress = (address: string) => `${chain.explorerUrl}/address/${address}`;

export function isAddress(value: string): value is Address {
  return viemIsAddress(value) && value.toLowerCase() !== zeroAddress;
}

export function normAddress(value: string): Address {
  return value.toLowerCase() as Address;
}

export function checksum(value: string): Address {
  return getAddress(value);
}
