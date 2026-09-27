import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "./lib/supabase";
import { usePathname, useSearchParams } from "./routing";

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const pathname = usePathname();
  const params = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) {
        setSession(data.session);
        setReady(true);
      }
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!ready || session) return;
    const search = params.toString();
    const returnTo = pathname + (search ? "?" + search : "");
    void navigate({ to: "/login", search: { returnTo }, replace: true });
  }, [ready, session, pathname, params, navigate]);

  if (!ready || !session) return <main className="workspace-loading">Opening your workspace…</main>;
  return <>{children}</>;
}
