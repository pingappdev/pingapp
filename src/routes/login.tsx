import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const ClientLogin = import.meta.env.SSR ? null : lazy(() => import("../wallet/client-login"));

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
  return (
    <Suspense fallback={<main className="contact-page section">Checking your session…</main>}>
      {ClientLogin && <ClientLogin returnTo={returnTo} />}
    </Suspense>
  );
}
