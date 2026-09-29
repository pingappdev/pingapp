import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createSIWEConfig } from "@reown/appkit-siwe";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { createSiweMessage } from "viem/siwe";
import { WagmiProvider } from "wagmi";
import { endpoints } from "../api/client";
import { qk } from "../api/hooks";
import { chain, config } from "../config";

export const SIGN_IN_STATEMENT =
  "Sign in to PingApp. This only proves you own this wallet. It costs no gas and moves no funds.";

let activeQueryClient: QueryClient | undefined;

function QueryClientBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    activeQueryClient = queryClient;
    return () => {
      if (activeQueryClient === queryClient) activeQueryClient = undefined;
    };
  }, [queryClient]);
  return null;
}

export const wagmiAdapter = new WagmiAdapter({
  networks: [chain],
  projectId: config.reownProjectId,
  ssr: false,
});

export const siweConfig = createSIWEConfig({
  getMessageParams: async () => ({
    domain: window.location.host,
    uri: window.location.origin,
    chains: [chain.id],
    statement: SIGN_IN_STATEMENT,
  }),
  createMessage: (args) =>
    createSiweMessage({
      domain: args.domain,
      address: args.address.split(":").at(-1) as `0x${string}`,
      uri: args.uri,
      version: "1",
      chainId: args.chainId,
      nonce: args.nonce,
      statement: args.statement ?? SIGN_IN_STATEMENT,
      issuedAt: args.iat ? new Date(args.iat) : new Date(),
    }),
  getNonce: async () => (await endpoints.auth.nonce()).nonce,
  verifyMessage: async ({ message, signature }) => {
    try {
      const { me } = await endpoints.auth.verify(message, signature as `0x${string}`);
      activeQueryClient?.clear();
      activeQueryClient?.setQueryData(qk.session, me);
      return true;
    } catch {
      return false;
    }
  },
  getSession: async () => {
    try {
      const { me } = await endpoints.auth.session();
      activeQueryClient?.setQueryData(qk.session, me);
      return { address: me.address, chainId: chain.id };
    } catch {
      return null;
    }
  },
  signOut: async () => {
    try {
      await endpoints.auth.logout();
    } finally {
      activeQueryClient?.clear();
      activeQueryClient?.setQueryData(qk.session, null);
    }
    return true;
  },
  signOutOnDisconnect: true,
  // Keep the old cookie long enough for AuthGate to show the account mismatch.
  signOutOnAccountChange: false,
  signOutOnNetworkChange: false,
});

const modal = createAppKit({
  adapters: [wagmiAdapter],
  networks: [chain],
  defaultNetwork: chain,
  projectId: config.reownProjectId,
  siweConfig,
  metadata: {
    name: "PingApp",
    description: "Send crypto to a phone number",
    url: config.appUrl,
    icons: [`${config.appUrl.replace(/\/$/, "")}/assets/pingapp-logo-1x1.png`],
  },
  features: { email: false, socials: false, onramp: false, swaps: false, analytics: false },
  themeMode: "dark",
  themeVariables: { "--w3m-accent": "#c594ff", "--w3m-border-radius-master": "2px" },
  allowUnsupportedChain: false,
  enableWalletConnect: true,
  enableInjected: true,
  enableEIP6963: true,
  enableCoinbase: true,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientBridge />
      {children}
    </WagmiProvider>
  );
}

export const openConnect = () => modal.open();
export const openAccount = () => modal.open({ view: "Account" });
