import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { platformNavigateHome } from "../platform/navigation";
import { WalletProvider } from "./appkit";

export default function ClientLogout() {
  return (
    <WalletProvider>
      <LogoutContent />
    </WalletProvider>
  );
}

function LogoutContent() {
  const { signOut } = useAuth();
  const started = useRef(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const attemptLogout = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await signOut();
      platformNavigateHome();
    } catch (reason) {
      setError((reason as Error).message || "Could not sign out. Please try again.");
      setBusy(false);
    }
  }, [signOut]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void attemptLogout();
  }, [attemptLogout]);
  return (
    <main className="contact-page section">
      <div className="card settings-card" style={{ maxWidth: 460, margin: "60px auto" }}>
        <h1>Sign out</h1>
        {busy ? <p>Signing out…</p> : <p role="alert">{error}</p>}
        {!busy && (
          <button className="button accent" onClick={() => void attemptLogout()}>
            Try again
          </button>
        )}
      </div>
    </main>
  );
}
