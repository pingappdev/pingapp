import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import ClaimSafetyBox from "../wallet/ClaimSafetyBox";

const ClientClaim = import.meta.env.SSR ? null : lazy(() => import("../wallet/client-claim"));

export const Route = createFileRoute("/claim/$code")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "You have a pending transfer — PingApp" },
      { name: "description", content: "Review a pending send invite on PingApp." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ClaimRoute,
});

function ClaimRoute() {
  const { code } = Route.useParams();
  return (
    <Suspense fallback={<ClaimLoading />}>
      {ClientClaim ? <ClientClaim code={code} /> : <ClaimLoading />}
    </Suspense>
  );
}

function ClaimLoading() {
  return (
    <main className="contact-page section claim-page">
      <a className="wordmark" href="/">
        PingApp
      </a>
      <div className="card settings-card claim-card">
        <p role="status">Loading this invite…</p>
        <ClaimSafetyBox />
      </div>
    </main>
  );
}
