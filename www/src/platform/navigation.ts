import { config } from "@/env";
import { isStandaloneMarketingPath } from "@/lib/marketing-paths";
import { platform } from "./index";

/** Return the system-browser destination, or null for an in-app route. */
export function nativeExternalDestination(href: string, target = ""): string | null {
  const url = new URL(href, window.location.href);
  if (["mailto:", "tel:"].includes(url.protocol)) return url.href;
  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.origin === window.location.origin && isStandaloneMarketingPath(url.pathname)) {
    return new URL(url.pathname + url.search + url.hash, config.appUrl).href;
  }
  return url.origin !== window.location.origin || target === "_blank" ? url.href : null;
}

/** MOB-09 uses this after account deletion; logout uses it now. */
export function platformNavigateHome() {
  if (platform.isNative) {
    window.dispatchEvent(
      new CustomEvent("pingapp:navigate", { detail: { href: "/login", replace: true } }),
    );
  } else {
    window.location.replace("/");
  }
}
