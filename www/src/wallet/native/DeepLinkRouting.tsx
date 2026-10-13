import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@/routing";
import { qk } from "@/api/hooks";
import type { Me } from "@/api/types";
import { keyManager } from "./keyManager";
import { lockAccess } from "./lockPolicy";
import { pendingDeepLink } from "./deepLinks";

export default function DeepLinkRouting() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const path = useSyncExternalStore(pendingDeepLink.subscribe, pendingDeepLink.getSnapshot);
  const state = useSyncExternalStore(keyManager.subscribe, keyManager.getState);
  const access = useSyncExternalStore(lockAccess.subscribe, lockAccess.getSnapshot);
  const session = useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => queryClient.getQueryData<Me | null>(qk.session),
  );
  useEffect(() => {
    if (!path) return;
    if (state === "unlocked" && access === "ready" && session) {
      router.replace(path);
      // Keep the pending destination until the router has actually arrived.
      // A process kill during navigation therefore retains the accepted link.
      const timer = window.setInterval(() => {
        if (location.pathname + location.search === path) {
          clearInterval(timer);
          void pendingDeepLink.consume(path).catch(() => {});
        }
      }, 50);
      return () => clearInterval(timer);
    }
    router.replace(`/login?returnTo=${encodeURIComponent(path)}`);
    return undefined;
  }, [path, state, access, session, router]);
  return null;
}
