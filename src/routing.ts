import { useMemo } from "react";
import { useRouterState, useRouter as useTanstackRouter } from "@tanstack/react-router";

export function usePathname() {
  return useRouterState({ select: (s) => s.location.pathname });
}

export function useSearchParams() {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  return useMemo(() => new URLSearchParams(searchStr), [searchStr]);
}

export function useRouter() {
  const router = useTanstackRouter();
  return useMemo(
    () => ({
      push: (href: string, options?: { scroll?: boolean }) => {
        void (router.navigate as (opts: { href: string }) => unknown)({ href });
        if (options?.scroll !== false) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      },
      prefetch: (href: string) => {
        void Promise.resolve(
          (router.preloadRoute as (opts: { href: string }) => unknown)({ href }),
        ).catch(() => {});
      },
    }),
    [router],
  );
}
