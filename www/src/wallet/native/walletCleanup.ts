import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { clearToken, signOutNative } from "@/auth/nativeSession";
import { platform } from "@/platform";
import { platformNavigateHome } from "@/platform/navigation";
import { keyManager } from "./keyManager";

const CLEANUP_KEY = "pingapp.wallet.cleanup.v1";
type Action = "delete" | "remove" | "delete-pending";
type Cleanup = { action: Action; busy: boolean; error: string } | null;
let snapshot: Cleanup = null;
let running: Promise<void> | undefined;
const listeners = new Set<() => void>();
function publish(next: Cleanup) {
  snapshot = next;
  for (const listener of listeners) listener();
}

// Root-owned recovery survives the Settings unmount caused by locking/wiping.
export const walletCleanup = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot: () => snapshot,
  async discover() {
    const stored = await platform.secureStorage.get(CLEANUP_KEY);
    if (stored === "delete" || stored === "remove" || stored === "delete-pending")
      publish({ action: stored, busy: false, error: "Finish removing this wallet from your device." });
    return snapshot !== null;
  },
  async beforeDelete() {
    // Persist before the request, so process death cannot silently recreate the
    // old account. An unconfirmed request never authorizes a wallet wipe.
    await platform.secureStorage.set(CLEANUP_KEY, "delete-pending");
  },
  async deleteFailed() {
    try {
      await platform.secureStorage.remove(CLEANUP_KEY);
    } catch {
      publish({ action: "delete-pending", busy: false, error: "Account deletion could not be confirmed. Your wallet has been preserved." });
      throw new Error("Account deletion could not be confirmed. Your wallet has been preserved.");
    }
  },
  async keepUnconfirmedWallet() {
    if (snapshot?.action !== "delete-pending" || running) return;
    try {
      await platform.secureStorage.remove(CLEANUP_KEY);
      keyManager.lock();
      platformNavigateHome();
      publish(null);
    } catch {
      publish({ action: "delete-pending", busy: false, error: "Could not clear the interrupted deletion. Your wallet has been preserved. Try again." });
    }
  },
  start(action: Action, client: QueryClient) {
    publish({ action, busy: true, error: "" });
    return this.retry(client);
  },
  retry(client: QueryClient): Promise<void> {
    if (running) return running;
    if (!snapshot || snapshot.action === "delete-pending") return Promise.resolve();
    const action = snapshot.action;
    publish({ action, busy: true, error: "" });
    running = (async () => {
      let revocationUnconfirmed = false;
      try {
        // A cold start must finish cleanup rather than sign in with a deleted account.
        await platform.secureStorage.set(CLEANUP_KEY, action);
        try {
          await signOutNative();
        } catch {
          revocationUnconfirmed = action === "remove";
        }
        // Retry local token removal separately: logout can fail offline or in storage.
        await clearToken();
        await keyManager.wipe();
        await client.cancelQueries();
        client.clear();
        await platform.secureStorage.remove(CLEANUP_KEY);
        platformNavigateHome();
        publish(null);
        if (revocationUnconfirmed)
          toast.warning("Wallet removed. Server sign-out could not be confirmed; its session may remain valid until it expires.");
      } catch {
        // Never show cached account data or claim that a failed local wipe succeeded.
        keyManager.lock();
        await client.cancelQueries();
        client.clear();
        publish({
          action,
          busy: false,
          error: action === "delete"
            ? "Your PingApp account was deleted. Device cleanup is incomplete. Retry to remove the local wallet and session."
            : "Device cleanup is incomplete. Your PingApp account stays on the server. Retry to remove the local wallet and session.",
        });
      }
    })().finally(() => { running = undefined; });
    return running;
  },
};
