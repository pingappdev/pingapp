import { platform } from "@/platform";
import { useRefreshApp } from "@/platform/useRefreshApp";
import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw, Wallet } from "lucide-react";
import { useAccount } from "wagmi";
import { useAuth, safeReturnTo } from "./auth/useAuth";
import { trimAddress } from "./dashboard/format";
import { useRouter } from "./routing";
import { isNativeBuild } from "./env";

export default function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const refreshApp = useRefreshApp();
  const { status, me, address, error: sessionError, retrySession, signIn, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const account = useAccount();
  const walletMissing = account.status === "disconnected";
  // wagmi reports "disconnected" for a moment before it restores a saved connection.
  const [walletSettled, setWalletSettled] = useState(false);
  useEffect(() => {
    if (walletSettled) return;
    if (account.status === "connected") return setWalletSettled(true);
    const timer = window.setTimeout(() => setWalletSettled(true), 1500);
    return () => window.clearTimeout(timer);
  }, [account.status, walletSettled]);

  useEffect(() => {
    if (status !== "signed-out" || switching) return;
    const returnTo = safeReturnTo(window.location.pathname + window.location.search);
    router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [status, switching, router]);

  if (isNativeBuild && status === "signed-in") return <>{children}</>;

  if (
    status === "loading" ||
    (status === "signed-out" && !switching) ||
    (!isNativeBuild && status === "signed-in" && (account.status === "reconnecting" || !walletSettled))
  ) {
    return (
      <main className="premium-workspace contact-page section">
        <div className="workspace-loading">
          <RefreshCw className="spin" />
          Opening your workspace…
        </div>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="premium-workspace contact-page section">
        <div className="card settings-card" style={{ maxWidth: 540, margin: "60px auto" }}>
          <h1>We couldn’t check your session.</h1>
          <p role="alert">{sessionError?.message ?? "Check your connection and try again."}</p>
          <button
            className="button accent"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void retrySession().finally(() => setBusy(false));
            }}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (status === "signed-out") {
    return (
      <main className="premium-workspace contact-page section">
        <div className="card settings-card" style={{ maxWidth: 540, margin: "60px auto" }}>
          <h1>Sign in with your wallet.</h1>
          {error && <p role="alert">{error}</p>}
          <button className="button accent" onClick={signIn}>
            Connect wallet
          </button>
        </div>
      </main>
    );
  }

  if (platform.isNative && (status === "mismatch" || (status === "signed-in" && walletMissing))) {
    return (
      <main className="premium-workspace contact-page section">
        <div className="card settings-card wallet-gate">
          <h1>Your device wallet is unavailable.</h1>
          <p>Refresh your session to continue with the wallet on this device.</p>
          <button className="button accent" onClick={refreshApp}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (status === "mismatch") {
    return (
      <main className="premium-workspace contact-page section">
        <div className="card settings-card" style={{ maxWidth: 540, margin: "60px auto" }}>
          <h1>Your wallet changed.</h1>
          <p>
            Your wallet switched to {trimAddress(address ?? "")}. You’re signed in as{" "}
            {trimAddress(me?.address ?? "")}.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="settings-buttons">
            <button
              className="button accent"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setSwitching(true);
                setError("");
                try {
                  await signOut();
                  signIn();
                } catch (reason) {
                  setError((reason as Error).message || "Could not sign out. Try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Sign in as the new wallet
            </button>
            <button className="button outline" onClick={refreshApp}>
              Switch back in your wallet
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (status === "signed-in" && walletMissing) {
    return (
      <main className="premium-workspace contact-page section">
        <div className="card settings-card wallet-gate">
          <span className="round-icon">
            <Wallet size={18} />
          </span>
          <h1>Reconnect your wallet</h1>
          <p>
            You’re signed in as {trimAddress(me?.address ?? "")}. Connect that wallet to open your
            workspace.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="settings-buttons">
            <button className="button accent" onClick={signIn}>
              Connect wallet
            </button>
            <button
              className="button outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await signOut();
                } catch (reason) {
                  setError((reason as Error).message || "Could not sign out. Try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
