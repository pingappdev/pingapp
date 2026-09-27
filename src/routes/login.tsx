import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { client } from "@/lib/supabase";

type LoginSearch = { returnTo?: string };

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    returnTo: typeof search["returnTo"] === "string" ? (search["returnTo"] as string) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in — PingApp" },
      { name: "description", content: "Sign in to your private PingApp workspace." },
      { property: "og:title", content: "Sign in — PingApp" },
      { property: "og:description", content: "Sign in to your private PingApp workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Login,
});

function Login() {
  const { returnTo } = Route.useSearch();
  const next = returnTo ?? "/dashboard";
  const safeNext = next.startsWith("/dashboard") ? next : "/dashboard";
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  return (
    <main className="contact-page section">
      <a className="wordmark" href="/">
        PingApp
      </a>
      <div className="card settings-card" style={{ maxWidth: 460, margin: "60px auto" }}>
        <h1 style={{ fontSize: 44 }}>Welcome back.</h1>
        <p>Sign in to your private PingApp workspace.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const { error } = await client().auth.signInWithOtp({
                email,
                options: { emailRedirectTo: window.location.origin + safeNext },
              });
              if (error) throw error;
              setMessage("Check your email for your secure sign-in link.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email address
            <input
              className="auth-input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <button disabled={busy} className="button accent" style={{ marginTop: 22, width: "100%" }}>
            {busy ? "Sending…" : "Send sign-in link"}
          </button>
        </form>
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </main>
  );
}
