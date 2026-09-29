import { createFileRoute } from "@tanstack/react-router";

type LoginSearch = { returnTo?: string };

export const Route = createFileRoute("/login")({
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
  return (
    <main className="contact-page section">
      <a className="wordmark" href="/">PingApp</a>
      <div className="card settings-card" style={{ maxWidth: 460, margin: "60px auto" }}>
        <h1 style={{ fontSize: 44 }}>Welcome back.</h1>
        <p>Wallet sign-in coming soon.</p>
        <a className="button accent" href="/" style={{ marginTop: 22 }}>Back to PingApp</a>
      </div>
    </main>
  );
}
