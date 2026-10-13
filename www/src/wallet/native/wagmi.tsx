import { useEffect, type ReactNode } from "react";
import { createConfig, WagmiProvider } from "wagmi";
import { connect, getAccount } from "wagmi/actions";
import { chain } from "@/config";
import { keyManager } from "./keyManager";
import { localWallet } from "./connector";
import { relayTransport } from "./provider";

export const nativeWagmiConfig = createConfig({
  chains: [chain],
  connectors: [localWallet()],
  transports: { [chain.id]: relayTransport } as Record<typeof chain.id, typeof relayTransport>,
  multiInjectedProviderDiscovery: false,
  ssr: false,
  // Connection state is derived from secure wallet state, not browser storage.
  storage: null,
});

let connecting: Promise<unknown> | undefined;
export function connectNativeWallet(): Promise<unknown> {
  if (keyManager.getState() !== "unlocked") return Promise.resolve();
  if (getAccount(nativeWagmiConfig).isConnected) return Promise.resolve();
  connecting ??= connect(nativeWagmiConfig, { connector: nativeWagmiConfig.connectors[0] }).finally(
    () => {
      connecting = undefined;
    },
  );
  return connecting;
}

function WalletConnection() {
  useEffect(() => {
    const reconnect = () => {
      void connectNativeWallet().catch(() => {});
    };
    const unsubscribe = keyManager.subscribe(reconnect);
    reconnect();
    return unsubscribe;
  }, []);
  return null;
}

export function NativeWalletProvider({ children }: { children: ReactNode }) {
  // The root already owns QueryClientProvider; use the same client/cache.
  return (
    <WagmiProvider config={nativeWagmiConfig} reconnectOnMount={false}>
      <WalletConnection />
      {children}
    </WagmiProvider>
  );
}
