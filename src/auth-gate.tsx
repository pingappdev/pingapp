import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useAuth, safeReturnTo } from "./auth/useAuth";
import { trimAddress } from "./dashboard/format";
import { useAccount, useSwitchChain } from "wagmi";
import { chain } from "./config";

export default function AuthGate({ children }: { children: ReactNode }) {
  const { status, me, address, signIn, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const account = useAccount();
  const { switchChainAsync } = useSwitchChain();

  useEffect(() => {
    if (status !== "signed-out" || switching) return;
    const returnTo = safeReturnTo(window.location.pathname + window.location.search);
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [status, switching]);

  if (status === "loading" || (status === "signed-out" && !switching)) {
    return (
      <main className="premium-workspace contact-page section">
        <div className="workspace-loading">
          <RefreshCw className="spin" />
          Opening your workspace…
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
            <button className="button outline" onClick={() => window.location.reload()}>
              Switch back in your wallet
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (account.isConnected && account.chainId !== chain.id) {
    return (
      <main className="premium-workspace contact-page section">
        <div className="card settings-card" style={{ maxWidth: 540, margin: "60px auto" }}>
          <h1>Switch to {chain.name}.</h1>
          <p>Your wallet is connected on another network.</p>
          {error && <p role="alert">{error}</p>}
          <button
            className="button accent"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await switchChainAsync({ chainId: chain.id });
              } catch (reason) {
                setError((reason as Error).message || "Could not switch network.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Switch network
          </button>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
