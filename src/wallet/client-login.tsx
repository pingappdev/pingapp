import { useEffect, useState } from "react";
import { useAuth, safeReturnTo } from "../auth/useAuth";
import { WalletProvider } from "./appkit";

export default function ClientLogin({ returnTo }: { returnTo?: string }) {
  return (
    <WalletProvider>
      <LoginContent returnTo={returnTo} />
    </WalletProvider>
  );
}

function LoginContent({ returnTo }: { returnTo?: string }) {
  const { status, error: sessionError, retrySession, signIn, signOut } = useAuth();
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    if (status === "signed-in") window.location.replace(safeReturnTo(returnTo));
  }, [status, returnTo]);

  return (
    <main className="contact-page section">
      <a className="wordmark" href="/">
        PingApp
      </a>
      <div className="card settings-card" style={{ maxWidth: 460, margin: "60px auto" }}>
        <h1 style={{ fontSize: 44 }}>Sign in with your wallet.</h1>
        <p>No email, no password. PingApp never asks for your seed phrase.</p>
        {status === "mismatch" && (
          <p>
            Your connected wallet is different from the current session. Sign in as the new wallet
            to continue.
          </p>
        )}
        {status === "error" && (
          <div role="alert">
            <p>{sessionError?.message ?? "We couldn’t check your session."}</p>
            <button className="button outline" onClick={() => void retrySession()}>
              Try again
            </button>
          </div>
        )}
        {actionError && <p role="alert">{actionError}</p>}
        <button
          className="button accent"
          onClick={
            status === "mismatch"
              ? () => {
                  setActionError("");
                  void signOut()
                    .then(signIn)
                    .catch((reason: unknown) =>
                      setActionError((reason as Error).message || "Could not sign out. Try again."),
                    );
                }
              : signIn
          }
          disabled={status === "loading" || status === "signed-in" || status === "error"}
          style={{ marginTop: 22, width: "100%", justifyContent: "center" }}
        >
          {status === "loading" || status === "signed-in"
            ? "Checking your session…"
            : status === "mismatch"
              ? "Sign in as the new wallet"
              : "Connect wallet"}
        </button>
        <p className="field-help" style={{ marginTop: 18 }}>
          Signing is free. It proves you own this wallet and moves no funds.
        </p>
        <a className="text-link" href="/what-we-do/connect">
          New to crypto wallets?
        </a>
      </div>
    </main>
  );
}
