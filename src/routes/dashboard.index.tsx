import { createFileRoute } from "@tanstack/react-router";
import AuthGate from "@/auth-gate";
import Dashboard from "@/dashboard-client";

export const Route = createFileRoute("/dashboard/")({
  head: () => ({
    meta: [
      { title: "Overview — PingApp Dashboard" },
      { name: "description", content: "Your PingApp balances, contacts and recent transfers." },
      { property: "og:title", content: "Overview — PingApp Dashboard" },
      { property: "og:description", content: "Your PingApp balances, contacts and recent transfers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <AuthGate>
      <Dashboard view="overview" />
    </AuthGate>
  ),
});
