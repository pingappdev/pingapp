import { createFileRoute } from "@tanstack/react-router";
import Marketing from "@/marketing";

const pages = [
  "what-we-do",
  "what-we-do/resolve",
  "what-we-do/connect",
  "what-we-do/security",
  "who-we-are",
  "case-studies",
  "insights",
  "insights/phone-to-wallet",
  "insights/your-keys",
  "insights/safer-connections",
  "contact",
  "privacy",
  "terms",
];

const meta: Record<string, { title: string; description: string }> = {
  "what-we-do": {
    title: "What We Do — PingApp",
    description: "Phone-to-wallet connections, wallet handoff, and security, explained.",
  },
  "what-we-do/resolve": {
    title: "Phone-to-Wallet — PingApp",
    description: "How a familiar phone number connects to the wallet someone controls.",
  },
  "what-we-do/connect": {
    title: "Wallet Connection — PingApp",
    description: "Connect a browser wallet or view a public address, without sharing keys.",
  },
  "what-we-do/security": {
    title: "Security — PingApp",
    description: "PingApp never holds private keys. Every transfer is approved in your own wallet.",
  },
  "who-we-are": {
    title: "Who We Are — PingApp",
    description: "The team building a friendlier directory layer for everyday crypto transfers.",
  },
  "case-studies": {
    title: "Use Cases — PingApp",
    description: "Everyday ways people use PingApp to send crypto to people they know.",
  },
  insights: {
    title: "Insights — PingApp",
    description: "Perspectives on phone-to-wallet connections, ownership, and safer sending.",
  },
  "insights/phone-to-wallet": {
    title: "Phone to Wallet — PingApp Insights",
    description: "A closer look at the directory layer making crypto feel more human.",
  },
  "insights/your-keys": {
    title: "Your Keys, Your Funds — PingApp Insights",
    description: "Why PingApp never holds your private keys, and what that means for you.",
  },
  "insights/safer-connections": {
    title: "Safer Connections — PingApp Insights",
    description: "Clear confirmations and careful habits for sending crypto to people you know.",
  },
  contact: {
    title: "Contact Us — PingApp",
    description: "Get in touch with the PingApp team.",
  },
  privacy: {
    title: "Privacy — PingApp",
    description: "How PingApp handles your account data and saved contacts.",
  },
  terms: {
    title: "Terms — PingApp",
    description: "The terms that apply when you use PingApp.",
  },
};

const pageFromParams = (splat: string | undefined) =>
  (splat ?? "").replace(/^\//, "").replace(/\/$/, "");

export const Route = createFileRoute("/$")({
  head: ({ params }) => {
    const page = pageFromParams((params as { _splat?: string })._splat);
    const info = meta[page] ?? {
      title: "Page not found — PingApp",
      description: "This connection doesn’t lead anywhere.",
    };
    return {
      meta: [
        { title: info.title },
        { name: "description", content: info.description },
        { property: "og:title", content: info.title },
        { property: "og:description", content: info.description },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary_large_image" },
        ...(meta[page] ? [] : [{ name: "robots", content: "noindex" }]),
      ],
    };
  },
  component: MarketingRoute,
});

function MarketingRoute() {
  const { _splat } = Route.useParams();
  const page = pageFromParams(_splat);
  if (!pages.includes(page)) return <Missing />;
  return <Marketing key={page} page={page} />;
}

function Missing() {
  return (
    <main className="contact-page section">
      <h1>Page not found.</h1>
      <p>This connection doesn’t lead anywhere.</p>
      <a className="button" href="/">
        Back to PingApp
      </a>
    </main>
  );
}
