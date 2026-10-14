import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { platform, PlatformError } from "@/platform";
import { keyManager, WalletError } from "./keyManager";
import { lockAccess, unlockWallet } from "./lockPolicy";
import { useQueryClient } from "@tanstack/react-query";
import { walletCleanup } from "./walletCleanup";
import { Keyboard } from "@capacitor/keyboard";
import { acceptOptionalScreenLock } from "./deviceSecurity";
import NoScreenLockChoice from "./NoScreenLockChoice";
import LocalApprovalDialog from "./LocalApprovalDialog";

export default function LockGate({ children }: { children: ReactNode }) {
  return (
    <>
      <WalletGate>{children}</WalletGate>
      <LocalApprovalDialog />
    </>
  );
}

function WalletGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(keyManager.subscribe, keyManager.getState);
  const access = useSyncExternalStore(lockAccess.subscribe, lockAccess.getSnapshot);
  const cleanup = useSyncExternalStore(walletCleanup.subscribe, walletCleanup.getSnapshot);
  const queryClient = useQueryClient();
  const [discovered, setDiscovered] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const cleanupWasActive = useRef(false);
  const discovery = useRef(false);
  discovery.current = discovered;
  const contentWasMounted = useRef(false);
  const ready =
    discovered && access === "ready" && (onboarding || state === "none" || state === "unlocked");
  // A brief external Activity must not discard an already unlocked form/picker
  // continuation. Cold discovery, onboarding, real locks and cleanup still
  // unmount it. Keep this separate from the permission to interact below.
  const checking =
    !cleanup &&
    discovered &&
    state === "unlocked" &&
    access === "checking" &&
    contentWasMounted.current;
  const showContent = !cleanup && (ready || checking);
  useLayoutEffect(() => {
    contentWasMounted.current = showContent;
  }, [showContent]);
  const suppressSnapshots = !showContent || checking;
  useLayoutEffect(() => {
    if (!suppressSnapshots) return;
    // PageTransitions lives outside this gate. Its old page bitmap must not
    // overlay either the temporary curtain or a subsequent real lock screen.
    const style = document.createElement("style");
    style.textContent = "html::view-transition { display: none !important; }";
    document.head.append(style);
    // WebView blur does not reliably dismiss Android's separate IME window.
    // Hide it for every gated state as well as the temporary resume curtain.
    void Keyboard.hide().catch(() => {});
    return () => style.remove();
  }, [suppressSnapshots]);
  useLayoutEffect(() => {
    if (!checking) return;
    // Radix portals escape the route tree into body. Hide/inert the WHOLE body
    // before paint, including portals mounted while the OS check is pending.
    // A private stylesheet avoids overwriting Radix's body styles/scroll lock.
    const body = document.body;
    const wasInert = body.inert;
    const curtain = document.createElement("style");
    curtain.textContent = `body { display: none !important; }
      html::after { content: "Checking device security…"; position: fixed;
        inset: 0; display: grid; place-items: center; background: #08080c;
        color: #fff; font: 16px system-ui; }`;
    document.head.append(curtain);
    body.inert = true;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return () => {
      curtain.remove();
      body.inert = wasInert;
    };
  }, [checking]);

  const unlock = useCallback(async (discover = !discovery.current) => {
    const generation = ++attempt.current;
    const current = () => mounted.current && attempt.current === generation;
    let discoveryPending = discover;
    setBusy(true);
    setError("");
    try {
      if (discover) {
        if (await walletCleanup.discover()) return;
        if (!current()) return;
        const exists = await keyManager.hasWallet();
        if (!current()) return;
        const ownAddress = exists ? await keyManager.address() : null;
        if (!current()) return;
        setAddress(ownAddress ?? "");
        setOnboarding(!exists);
        setDiscovered(true);
        discoveryPending = false;
        if (!exists) return;
      }
      await unlockWallet(current);
      if (current()) setBlocked(false);
    } catch (reason) {
      if (!current()) return;
      setBlocked(reason instanceof WalletError && reason.code === "DeviceLockRequired");
      setError(
        discoveryPending
          ? "The device wallet could not be opened. Try again."
          : reason instanceof WalletError || reason instanceof PlatformError
            ? reason.message
            : "Could not unlock your wallet. Try again.",
      );
    } finally {
      if (current()) setBusy(false);
    }
  }, []);
  const unmount = useCallback(() => {
    mounted.current = false;
    attempt.current++;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void unlock(true);
    return unmount;
  }, [unlock, unmount]);
  useEffect(() => {
    if (state === "unlocked") setOnboarding(false);
    if (state === "none" && discovered) {
      setOnboarding(true);
      setAddress("");
    }
  }, [state, discovered]);
  useEffect(() => {
    if (access === "blocked") setBlocked(true);
  }, [access]);
  useEffect(() => {
    if (cleanup) cleanupWasActive.current = true;
    else if (cleanupWasActive.current) {
      cleanupWasActive.current = false;
      void unlock(true);
    }
  }, [cleanup, unlock]);

  if (cleanup)
    return (
      <main
        className="contact-page section"
        role="dialog"
        aria-modal="true"
        aria-label="Finish wallet cleanup"
      >
        <span className="wordmark">PingApp</span>
        <div
          className="card settings-card"
          style={{ maxWidth: 460, minWidth: 0, margin: "60px auto", display: "grid", gap: 18 }}
        >
          <h1 style={{ fontSize: 30, minWidth: 0, whiteSpace: "normal", overflowWrap: "anywhere" }}>
            {cleanup.finished ? "Wallet removed" : "Finish device cleanup"}
          </h1>
          <p>
            {cleanup.action === "delete"
              ? "Your PingApp account was deleted. Funds stay on-chain."
              : cleanup.action === "delete-pending"
                ? "Account deletion was interrupted and could not be confirmed. Your key is still on this device. Keeping it preserves access to on-chain funds. If deletion completed, signing in again creates an account for this wallet."
                : "Your PingApp account stays on the server. Funds stay on-chain."}
          </p>
          {cleanup.error && <p role="alert">{cleanup.error}</p>}
          <button
            className="button accent"
            disabled={cleanup.busy}
            onClick={() =>
              void (cleanup.finished
                ? walletCleanup.finish()
                : cleanup.action === "delete-pending"
                  ? walletCleanup.keepUnconfirmedWallet()
                  : walletCleanup.retry(queryClient))
            }
          >
            {cleanup.busy
              ? "Removing wallet…"
              : cleanup.finished
                ? "Continue to Welcome"
                : cleanup.action === "delete-pending"
                  ? "Keep wallet and continue"
                  : "Retry device cleanup"}
          </button>
        </div>
      </main>
    );
  if (showContent) return <>{children}</>;
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
          {blocked ? "Protect your wallet" : "Your wallet is locked"}
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
        {blocked && (
          <NoScreenLockChoice
            busy={busy || access === "checking"}
            onContinue={() => {
              setBusy(true);
              setError("");
              void acceptOptionalScreenLock()
                .then(() => {
                  return mounted.current ? unlock() : undefined;
                })
                .catch(() => {
                  if (mounted.current) setError("Could not save your choice. Try again.");
                })
                .finally(() => {
                  if (mounted.current) setBusy(false);
                });
            }}
          />
        )}
        <button
          className="button accent"
          disabled={busy || access === "checking"}
          onClick={() => void unlock()}
        >
          {busy ? "Unlocking…" : error ? "Retry" : "Unlock"}
        </button>
      </div>
    </main>
  );
}
