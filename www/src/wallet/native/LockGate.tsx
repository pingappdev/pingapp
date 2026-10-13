import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { platform, PlatformError } from "@/platform";
import { keyManager, WalletError } from "./keyManager";
import { unlockWallet } from "./lockPolicy";

export default function LockGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(keyManager.subscribe, keyManager.getState);
  const [discovered, setDiscovered] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [onboarding, setOnboarding] = useState(false);

  async function unlock() {
    setBusy(true);
    setError("");
    try {
      await unlockWallet();
      setBlocked(false);
    } catch (reason) {
      setBlocked(reason instanceof WalletError && reason.code === "DeviceLockRequired");
      setError(
        reason instanceof WalletError || reason instanceof PlatformError
          ? reason.message
          : "Could not unlock your wallet. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      const exists = await keyManager.hasWallet();
      const ownAddress = exists ? await keyManager.address() : null;
      if (!active) return;
      setAddress(ownAddress ?? "");
      setOnboarding(!exists);
      setDiscovered(true);
      if (exists && keyManager.getState() !== "unlocked") void unlock();
    })().catch(() => {
      if (active) setError("The device wallet could not be opened. Try again.");
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (state === "unlocked") setOnboarding(false);
  }, [state]);

  if (discovered && (onboarding || state === "none" || state === "unlocked"))
    return <>{children}</>;
  return (
    <main
      className="contact-page section"
      role="dialog"
      aria-modal="true"
      aria-label="Wallet locked"
    >
      <span className="wordmark">PingApp</span>
      <div
        className="card settings-card"
        style={{ maxWidth: 460, margin: "60px auto", display: "grid", gap: 18 }}
      >
        <h1 style={{ fontSize: 30 }}>
          {blocked ? "Set a screen lock to use PingApp" : "Your wallet is locked"}
        </h1>
        {address && (
          <p>
            {address.slice(0, 6)}…{address.slice(-4)}
          </p>
        )}
        <p>
          {blocked
            ? "Your wallet is still stored on this device. Set a PIN or password in device Settings, then return here."
            : "Unlock to open your private workspace."}
        </p>
        {error && <p role="alert">{error}</p>}
        {blocked && (
          <button
            className="button outline"
            onClick={() =>
              void platform
                .openSecuritySettings()
                .catch(() => setError("Open device Settings → Security and set a screen lock."))
            }
          >
            Open settings
          </button>
        )}
        <button
          className="button accent"
          disabled={busy || !discovered}
          onClick={() => void unlock()}
        >
          {busy ? "Unlocking…" : error ? "Retry" : "Unlock"}
        </button>
      </div>
    </main>
  );
}
