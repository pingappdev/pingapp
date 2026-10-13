import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Extra dev-server hosts (e.g. a tunnelled test domain), comma-separated.
const extraHosts = (process.env.DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  nitro: { preset: process.env.VERCEL ? "vercel" : "node-server" },
  vite: {
    server: {
      host: true,
      port: 7400,
      strictPort: true,
      allowedHosts: ["localhost", ".localhost", ...extraHosts],
    },
  },
});
