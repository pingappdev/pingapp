import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth, safeReturnTo } from "../auth/useAuth";
import LoginForm from "../auth/login-form";
import { useRouter } from "../routing";
import { openConnect, WalletProvider } from "./appkit";

type LoginProps = { returnTo?: string; autoConnect?: boolean };

export default function ClientLogin(props: LoginProps) {
  return (
    <WalletProvider>
      <LoginContent {...props} />
    </WalletProvider>
  );
}

function LoginContent({ returnTo, autoConnect }: LoginProps) {
  const { status, error: sessionError, retrySession, signOut } = useAuth();
  const router = useRouter();
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const requested = useRef(false);

  useEffect(() => {
    if (status === "signed-in") router.replace(safeReturnTo(returnTo));
  }, [status, returnTo, router]);

  const connect = useCallback(async () => {
    setBusy(true);
    setActionError("");
    try {
      if (status === "mismatch") await signOut();
      await openConnect();
    } catch (reason) {
      setActionError((reason as Error).message || "Could not open your wallet. Try again.");
    } finally {
      setBusy(false);
    }
  }, [status, signOut]);

  useEffect(() => {
    if (!autoConnect || requested.current || status !== "signed-out") return;
    requested.current = true;
    void connect();
  }, [autoConnect, status, connect]);

  return (
    <LoginForm
      status={status}
      sessionError={sessionError?.message}
      actionError={actionError}
      busy={busy}
      onRetry={() => void retrySession()}
      onConnect={() => void connect()}
    />
  );
}
