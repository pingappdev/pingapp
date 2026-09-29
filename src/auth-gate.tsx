import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useAuth, safeReturnTo } from "./auth/useAuth";
import { trimAddress } from "./dashboard/format";

export default function AuthGate({ children }: { children: ReactNode }) {
  const { status, me, address, signIn, signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status !== "signed-out") return;
    const returnTo = safeReturnTo(window.location.pathname + window.location.search);
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [status]);

  if (status === "loading" || status === "signed-out") {
    return <main className="premium-workspace contact-page section">
      <div className="workspace-loading"><RefreshCw className="spin" />Opening your workspace…</div>
    </main>;
  }

  if (status === "mismatch") {
    return <main className="premium-workspace contact-page section">
      <div className="card settings-card" style={{ maxWidth: 540, margin: "60px auto" }}>
        <h1>Your wallet changed.</h1>
        <p>Your wallet switched to {trimAddress(address ?? "")}. You’re signed in as {trimAddress(me?.address ?? "")}.</p>
        <div className="settings-buttons">
          <button className="button accent" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await signOut(); signIn(); }
            finally { setBusy(false); }
          }}>Sign in as the new wallet</button>
          <button className="button outline" onClick={() => window.location.reload()}>
            Switch back in your wallet
          </button>
        </div>
      </div>
    </main>;
  }

  return <>{children}</>;
}
