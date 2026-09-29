import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createSIWEConfig } from "@reown/appkit-siwe";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { createSiweMessage } from "viem/siwe";
import { WagmiProvider } from "wagmi";
import { ApiError, endpoints } from "../api/client";
import { qk, sessionRevision, transitionSession } from "../api/hooks";
import type { Me } from "../api/types";
import { chain, config } from "../config";

export const SIGN_IN_STATEMENT =
  "Sign in to PingApp. This only proves you own this wallet. It costs no gas and moves no funds.";

let activeQueryClient: QueryClient | undefined;

function appKitSession(me: Me | null | undefined) {
  return me ? { address: me.address, chainId: chain.id } : null;
}

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
      if (activeQueryClient)
        await transitionSession(activeQueryClient, me, { cancelSessionQuery: true });
      return true;
    } catch {
      return false;
    }
  },
  getSession: async () => {
    const queryClient = activeQueryClient;
    const expectedRevision = queryClient ? sessionRevision(queryClient) : undefined;
    try {
      const { me } = await endpoints.auth.session();
      if (!queryClient) return appKitSession(me);
      const applied = await transitionSession(queryClient, me, { expectedRevision });
      return appKitSession(applied ? me : queryClient.getQueryData<Me | null>(qk.session));
    } catch (error) {
      if (error instanceof ApiError && error.code === "UNAUTHENTICATED" && queryClient)
        await transitionSession(queryClient, null, {
          expectedRevision,
          cancelSessionQuery: true,
        });
      return appKitSession(queryClient?.getQueryData<Me | null>(qk.session));
    }
  },
  signOut: async () => {
    await endpoints.auth.logout();
    if (activeQueryClient)
      await transitionSession(activeQueryClient, null, { cancelSessionQuery: true });
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
  featuredWalletIds: [
    "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96", // MetaMask
    "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1", // Rabby
    "d0ca99ff52b99abc48743dad0f7fc891e041be73574f7fac4afe5d4bb83845c8", // Coinbase Wallet
    "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369", // Rainbow
    "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0", // Trust Wallet
  ],
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
