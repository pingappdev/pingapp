import { lazy, Suspense } from "react";

const ClientDashboard = lazy(() => import("./wallet/client-dashboard"));

export default function DashboardClient({ view }: { view: string }) {
  return <Suspense fallback={<main className="contact-page section">Opening your workspace…</main>}>
    <ClientDashboard view={view} />
  </Suspense>;
}
