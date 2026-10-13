// Native compatibility seam for existing shared wallet consumers. Vite replaces
// their resolved appkit import with this module before building the chunk graph.
// It contains no AppKit/Reown import. MOB-07 supplies onboarding/session policy.
import { NativeWalletProvider, nativeWagmiConfig, connectNativeWallet } from "./wagmi";
import { keyManager } from "./keyManager";

export const WalletProvider = NativeWalletProvider;
export const wagmiAdapter = { wagmiConfig: nativeWagmiConfig };
export const SIGN_IN_STATEMENT =
  "Sign in to PingApp. This only proves you own this wallet. It costs no gas and moves no funds.";

export async function openConnect() {
  if (keyManager.getState() === "unlocked") await connectNativeWallet();
  else window.dispatchEvent(new CustomEvent("pingapp:native-connect"));
}
export async function openAccount() {
  window.dispatchEvent(new CustomEvent("pingapp:native-account"));
}
