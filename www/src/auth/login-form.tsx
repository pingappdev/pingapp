import type { AuthStatus } from "./useAuth";

export default function LoginForm({
  status,
  sessionError,
  actionError,
  busy = false,
  onConnect,
  onRetry,
}: {
  status: AuthStatus;
  sessionError?: string;
  actionError?: string;
  busy?: boolean;
  onConnect: () => void;
  onRetry: () => void;
}) {
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
            <p>{sessionError ?? "We couldn’t check your session."}</p>
            <button className="button outline" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        {actionError && <p role="alert">{actionError}</p>}
        <button
          className="button accent"
          onClick={onConnect}
          disabled={busy || status === "loading" || status === "signed-in" || status === "error"}
          aria-busy={busy}
          style={{ marginTop: 22, width: "100%", justifyContent: "center" }}
        >
          {busy
            ? "Opening wallet…"
            : status === "loading" || status === "signed-in"
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
