import { createFileRoute } from "@tanstack/react-router";
import Marketing from "@/marketing";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PingApp — Send Crypto Like a Text" },
      {
        name: "description",
        content:
          "PingApp connects the phone number you already have to the wallet you already control. No address to copy, no QR to scan.",
      },
      { property: "og:title", content: "PingApp — Send Crypto Like a Text" },
      {
        property: "og:description",
        content: "Your number. Your wallet. A phone-to-wallet directory built around familiar contacts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

function Home() {
  return <Marketing page="home" />;
}
