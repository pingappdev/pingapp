import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/logout")({
  head: () => ({
    meta: [
      { title: "Signing out — PingApp" },
      { name: "description", content: "Signing out of your PingApp workspace." },
      { property: "og:title", content: "Signing out — PingApp" },
      { property: "og:description", content: "Signing out of your PingApp workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Logout,
});

function Logout() {
  useEffect(() => {
    void supabase.auth.signOut().then(() => window.location.replace("/"));
  }, []);
  return <main className="workspace-loading">Signing out…</main>;
}
