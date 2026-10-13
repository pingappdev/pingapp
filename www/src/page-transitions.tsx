"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "./routing";
import { flushSync } from "react-dom";
import { isStandaloneMarketingPath } from "./lib/marketing-paths";
import { platform } from "./platform";
import { nativeExternalDestination } from "./platform/navigation";
import { toast } from "sonner";

type Transition = { finished: Promise<void>; skipTransition: () => void };
type TransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void>) => Transition;
};
const reserved = (path: string) =>
  /^\/(signin-with-chatgpt|signout-with-chatgpt|callback|api)(\/|$)/.test(path);
const isDashboard = (path: string) => path === "/dashboard" || path.startsWith("/dashboard/");
const flipDirections = ["left", "up", "right", "down"] as const;

export default function PageTransitions({ children }: { children: React.ReactNode }) {
  const router = useRouter(),
    pathname = usePathname(),
    params = useSearchParams();
  const [entrance, setEntrance] = useState(true),
    [entranceRun, setEntranceRun] = useState(0);
  const route = pathname + "?" + params.toString();
  const routerRef = useRef(router);
  routerRef.current = router;
  const settled = useRef<null | (() => void)>(null),
    active = useRef<Transition | null>(null),
    pending = useRef(false),
    generation = useRef(0);
  const previous = useRef(route),
    prefetched = useRef(new Set<string>()),
    flipIndex = useRef(0),
    entranceTimer = useRef<number | null>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setEntrance(false);
      return;
    }
    entranceTimer.current = window.setTimeout(() => setEntrance(false), 1900);
    return () => {
      if (entranceTimer.current !== null) window.clearTimeout(entranceTimer.current);
    };
  }, []);
  useLayoutEffect(() => {
    if (previous.current === route) return;
    previous.current = route;
    const finish = settled.current;
    settled.current = null;
    void Promise.resolve().then(() => {
      if (finish && !location.hash) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      finish?.();
      pending.current = false;
      document.documentElement.removeAttribute("data-route-pending");
      const heading = document.querySelector<HTMLElement>("main h1");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    });
  }, [route]);
  useEffect(() => {
    const doc = document as TransitionDocument;
    const openExternal = (href: string) => {
      void platform.openExternal(href).catch(() => toast.error("Could not open this link."));
    };
    const go = (href: string, replace = false) => {
      if (platform.isNative) {
        const external = nativeExternalDestination(href);
        if (external) return openExternal(external);
        if (replace) return routerRef.current.replace(href);
      }
      const url = new URL(href, location.href);
      if (
        !platform.isNative && (
        url.origin !== location.origin ||
        reserved(url.pathname) ||
        isStandaloneMarketingPath(url.pathname))
      ) {
        location.assign(url.href);
        return;
      }
      if (url.href === location.href) return;
      const current = ++generation.current;
      settled.current?.();
      active.current?.skipTransition();
      pending.current = true;
      const enteringArea = isDashboard(url.pathname) !== isDashboard(location.pathname);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (enteringArea && !reduced) {
        if (entranceTimer.current !== null) window.clearTimeout(entranceTimer.current);
        flushSync(() => {
          setEntrance(true);
          setEntranceRun((run) => run + 1);
        });
        entranceTimer.current = window.setTimeout(() => {
          if (current === generation.current) setEntrance(false);
        }, 1900);
      }
      flushSync(() => window.dispatchEvent(new Event("pingapp:navigation-start")));
      const direction = flipDirections[flipIndex.current++ % flipDirections.length];
      document.documentElement.dataset.flipDirection = direction;
      const commit = () =>
        new Promise<void>((resolve) => {
          const timer = window.setTimeout(() => {
            if (current === generation.current) {
              settled.current = null;
              pending.current = false;
              document.documentElement.removeAttribute("data-route-pending");
            }
            resolve();
          }, 2200);
          settled.current = () => {
            clearTimeout(timer);
            resolve();
          };
          routerRef.current.push(url.pathname + url.search + url.hash, { scroll: true });
        });
      if (doc.startViewTransition && !reduced && !enteringArea) {
        const transition = doc.startViewTransition(commit);
        active.current = transition;
        void transition.finished
          .catch(() => {})
          .finally(() => {
            if (active.current === transition) active.current = null;
          });
      } else {
        if (!reduced) document.documentElement.setAttribute("data-route-pending", "true");
        void commit();
      }
    };
    const getAnchor = (event: Event) =>
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    const eligible = (a: HTMLAnchorElement) =>
      !a.download &&
      (!a.target || a.target === "_self") &&
      !a.hasAttribute("data-native-navigation") &&
      a.origin === location.origin &&
      /^https?:$/.test(a.protocol) &&
      !reserved(a.pathname);
    const clicked = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const a = getAnchor(event);
      if (!a) return;
      if (platform.isNative) {
        const external = nativeExternalDestination(a.href, a.target);
        if (external) {
          event.preventDefault();
          event.stopPropagation();
          openExternal(external);
          return;
        }
      }
      if (!eligible(a)) return;
      if (a.pathname === location.pathname && a.search === location.search && a.hash) return;
      event.preventDefault();
      go(a.href);
    };
    const warm = (event: Event) => {
      const a = getAnchor(event);
      if (!a || !eligible(a) || isStandaloneMarketingPath(a.pathname)) return;
      const path = a.pathname + a.search;
      if (prefetched.current.has(path)) return;
      prefetched.current.add(path);
      routerRef.current.prefetch(path);
    };
    const programmatic = (event: Event) => {
      const href = (event as CustomEvent<{ href: string; replace?: boolean }>).detail?.href;
      if (typeof href === "string") go(href, (event as CustomEvent).detail?.replace === true);
    };
    document.addEventListener("click", clicked, { capture: true });
    document.addEventListener("pointerover", warm, { passive: true });
    document.addEventListener("focusin", warm);
    window.addEventListener("pingapp:navigate", programmatic);
    return () => {
      document.removeEventListener("click", clicked, { capture: true });
      document.removeEventListener("pointerover", warm);
      document.removeEventListener("focusin", warm);
      window.removeEventListener("pingapp:navigate", programmatic);
      settled.current?.();
      active.current?.skipTransition();
      document.documentElement.removeAttribute("data-route-pending");
      document.documentElement.removeAttribute("data-flip-direction");
    };
  }, []);
  return (
    <>
      {children}
      <div
        key={entranceRun}
        className={`brand-entrance${entrance ? "" : " brand-entrance--done"}`}
        aria-hidden="true"
      >
        <div className="brand-entrance__identity">
          <div className="brand-entrance__mark">
            <img
              className="brand-entrance__piece brand-entrance__piece--one"
              src="/assets/pingapp-mark-transparent.png"
              alt=""
            />
            <img
              className="brand-entrance__piece brand-entrance__piece--two"
              src="/assets/pingapp-mark-transparent.png"
              alt=""
            />
            <img
              className="brand-entrance__piece brand-entrance__piece--three"
              src="/assets/pingapp-mark-transparent.png"
              alt=""
            />
          </div>
          <span className="brand-entrance__name">
            PingApp<span>®</span>
          </span>
          <span className="brand-entrance__rule" />
        </div>
      </div>
    </>
  );
}
