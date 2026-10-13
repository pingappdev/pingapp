import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSession } from "../api/hooks";
import LoginForm from "../auth/login-form";
import { safeReturnTo } from "../auth/return-to";
import { useRouter } from "../routing";
import type ClientLogin from "../wallet/client-login";

// Wallet SDKs must stay out of both initial browser loading and server builds.
const loadWalletLogin = import.meta.env.SSR ? null : () => import("../wallet/client-login");

type LoginSearch = { returnTo?: string };

export const Route = createFileRoute("/login")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in — PingApp" },
      { name: "description", content: "Sign in to your private PingApp workspace." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Login,
});

function Login() {
  const { returnTo } = Route.useSearch();
  const router = useRouter();
  const session = useSession();
  const [WalletLogin, setWalletLogin] = useState<typeof ClientLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (session.isSuccess && session.data && !WalletLogin) router.replace(safeReturnTo(returnTo));
  }, [session.isSuccess, session.data, WalletLogin, returnTo, router]);

  if (WalletLogin) return <WalletLogin returnTo={returnTo} autoConnect />;

  return (
    <LoginForm
      status={
        session.isPending
          ? "loading"
          : session.isError
            ? "error"
            : session.data
              ? "signed-in"
              : "signed-out"
      }
      sessionError={session.error?.message}
      actionError={error}
      busy={busy}
      onRetry={() => void session.refetch()}
      onConnect={() => {
        if (busy || !loadWalletLogin) return;
        setBusy(true);
        setError("");
        void loadWalletLogin()
          .then((module) => setWalletLogin(() => module.default))
          .catch(() => {
            setError("Couldn’t load wallet sign-in. Check your connection and try again.");
          })
          .finally(() => setBusy(false));
      }}
    />
  );
}
