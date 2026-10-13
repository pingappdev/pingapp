import { createConnector } from "wagmi";
import { toHex, type Address } from "viem";
import { chain } from "@/config";
import { keyManager } from "./keyManager";
import { nativeProvider, ProviderError } from "./provider";

export function localWallet() {
  return createConnector<typeof nativeProvider>((config) => {
    let connected = false;
    const accountsChanged = (...args: unknown[]) =>
      connector.onAccountsChanged(args[0] as string[]);
    const chainChanged = (...args: unknown[]) => connector.onChainChanged(args[0] as string);
    const disconnected = () => {
      if (connected) connector.onDisconnect();
    };
    const connector = {
      id: "pingapp-local",
      name: "PingApp device wallet",
      type: "injected",
      async setup() {
        nativeProvider.on("accountsChanged", accountsChanged);
        nativeProvider.on("chainChanged", chainChanged);
        nativeProvider.on("disconnect", disconnected);
      },
      async connect<withCapabilities extends boolean = false>({
        chainId,
        withCapabilities,
      }: { chainId?: number; withCapabilities?: withCapabilities | boolean } = {}) {
        if (chainId !== undefined && chainId !== chain.id)
          throw new ProviderError(4902, "Choose the configured Robinhood network.");
        const epoch = keyManager.getEpoch();
        const accounts = (await nativeProvider.request({
          method: "eth_requestAccounts",
        })) as Address[];
        if (keyManager.getState() !== "unlocked" || keyManager.getEpoch() !== epoch)
          throw new ProviderError(4100, "Unlock your wallet to connect.");
        connected = true;
        return {
          accounts: (withCapabilities
            ? accounts.map((address) => ({ address, capabilities: {} }))
            : accounts) as never,
          chainId: chain.id,
        };
      },
      async disconnect() {
        connected = false;
        keyManager.lock();
      },
      async getAccounts() {
        return (await nativeProvider.request({ method: "eth_accounts" })) as Address[];
      },
      async getChainId() {
        return chain.id;
      },
      async getProvider() {
        return nativeProvider;
      },
      async isAuthorized() {
        const exists = await keyManager.hasWallet();
        return exists && keyManager.getState() === "unlocked";
      },
      async switchChain({ chainId }: { chainId: number }) {
        await nativeProvider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: toHex(chainId) }],
        });
        return chain;
      },
      onAccountsChanged(accounts: string[]) {
        if (!connected) return;
        if (!accounts.length) this.onDisconnect();
        else config.emitter.emit("change", { accounts: accounts as Address[] });
      },
      onChainChanged(chainId: string) {
        if (connected) config.emitter.emit("change", { chainId: Number(chainId) });
      },
      onDisconnect() {
        if (!connected) return;
        connected = false;
        config.emitter.emit("disconnect");
      },
    };
    return connector;
  });
}
