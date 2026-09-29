import { defineConfig } from "@lovable.dev/vite-tanstack-config";

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
      allowedHosts: ["localhost", ".localhost"],
      hmr: { clientPort: 7400 },
    },
  },
});
