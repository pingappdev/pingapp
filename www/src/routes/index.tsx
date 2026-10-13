import { createFileRoute, redirect } from "@tanstack/react-router";
import { sitePageResponse } from "@/lib/site-pages.server";
import { isNativeBuild } from "@/env";

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: ({ request, next }) =>
        isNativeBuild ? next() : (sitePageResponse(new URL(request.url)) ?? next()),
    },
  },
  beforeLoad: ({ location }) => {
    if (isNativeBuild) throw redirect({ to: "/dashboard" });
    if (!import.meta.env.SSR) throw redirect({ href: location.href, reloadDocument: true });
  },
  // A UI component allows the native GET handler to defer to Start's shell.
  component: () => null,
  head: () => ({
    meta: [
      { title: "PingApp — Send Crypto Like a Text" },
      {
        name: "description",
        content:
          "Send ETH, USDG and Robinhood Stock Tokens on Robinhood Chain using verified phone numbers. Connect your own wallet and approve every transfer.",
      },
      { property: "og:title", content: "PingApp — Send Crypto Like a Text" },
      {
        property: "og:description",
        content:
          "Your number. Your wallet. Send on Robinhood Chain with verified phone links and your own wallet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});
