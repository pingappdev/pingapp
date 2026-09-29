import { createFileRoute } from "@tanstack/react-router";
import Dashboard from "@/dashboard-client";

const views: Record<string, { title: string; description: string }> = {
  overview: {
    title: "Overview — PingApp Dashboard",
    description: "Your PingApp balances, contacts and recent transfers.",
  },
  send: {
    title: "Send crypto — PingApp Dashboard",
    description: "Send ETH to a saved contact or a wallet address, approved in your own wallet.",
  },
  contacts: {
    title: "Contacts — PingApp Dashboard",
    description: "Save, search and remove the contacts in your private PingApp directory.",
  },
  activity: {
    title: "Activity — PingApp Dashboard",
    description: "Every transfer submitted through PingApp, with on-chain explorer links.",
  },
  settings: {
    title: "Settings — PingApp Dashboard",
    description: "Your display name, connected wallet, network and transfer confirmations.",
  },
};

export const Route = createFileRoute("/dashboard/$view")({
  ssr: false,
  head: ({ params }) => {
    const info = views[params.view] ?? {
      title: "Page not found — PingApp",
      description: "This connection doesn’t lead anywhere.",
    };
    return {
      meta: [
        { title: info.title },
        { name: "description", content: info.description },
        { property: "og:title", content: info.title },
        { property: "og:description", content: info.description },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: DashboardView,
});

function DashboardView() {
  const { view } = Route.useParams();
  if (!views[view])
    return (
      <main className="contact-page section">
        <h1>Page not found.</h1>
        <p>This connection doesn’t lead anywhere.</p>
        <a className="button" href="/dashboard">
          Back to your workspace
        </a>
      </main>
    );
  return <Dashboard view={view} />;
}
