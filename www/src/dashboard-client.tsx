import { lazy, Suspense } from "react";
import SessionGate from "./auth/session-gate";

const ClientDashboard = import.meta.env.SSR
  ? null
  : lazy(() => import("./wallet/client-dashboard"));

export default function DashboardClient({ view }: { view: string }) {
  return (
    <SessionGate>
      <Suspense fallback={<main className="contact-page section">Opening your workspace…</main>}>
        {ClientDashboard && <ClientDashboard view={view} />}
      </Suspense>
    </SessionGate>
  );
}
