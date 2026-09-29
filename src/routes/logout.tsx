import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const ClientLogout = lazy(() => import("../wallet/client-logout"));

export const Route = createFileRoute("/logout")({
  ssr: false,
  component: () => <Suspense fallback={null}><ClientLogout /></Suspense>,
});
