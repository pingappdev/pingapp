import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, type Plugin } from "vite";

const native = process.env.VITE_TARGET === "native";

function nativeBundle(): Plugin {
  return {
    name: "pingapp-native-bundle",
    config(_, { mode }) {
      const env = loadEnv(mode, process.cwd(), "VITE_");
      if (env.VITE_RPC_URL !== undefined || env.VITE_REOWN_PROJECT_ID !== undefined) {
        throw new Error("native builds must not embed RPC/Reown keys");
      }
    },
    // Marketing is a server document on web; native links leave the WebView.
    // Exclude the legacy React marketing renderer as well as public runtimes.
    transform(_, id) {
      if (id.split("?")[0] === resolve("src/marketing.tsx")) {
        return "export default function Marketing() { return null; }";
      }
      return null;
    },
    closeBundle() {
      mkdirSync("dist-native/assets", { recursive: true });
      copyFileSync("public/favicon.png", "dist-native/favicon.png");
      for (const file of ["pingapp-mark-transparent.png", "pingapp-logo-1x1.png"]) {
        copyFileSync(`public/assets/${file}`, `dist-native/assets/${file}`);
      }
      cpSync("public/assets/brands", "dist-native/assets/brands", { recursive: true });
    },
  };
}

// Extra dev-server hosts (e.g. a tunnelled test domain), comma-separated.
const extraHosts = (process.env.DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
    ...(native
      ? {
          client: { entry: "platform/client" },
          spa: { enabled: true, prerender: { outputPath: "/index" } },
        }
      : {}),
  },
  nitro: native ? false : { preset: process.env.VERCEL ? "vercel" : "node-server" },
  plugins: native ? [nativeBundle()] : [],
  vite: {
    ...(native
      ? { publicDir: false, environments: { client: { build: { outDir: "dist-native" } } } }
      : {}),
    server: {
      host: true,
      port: 7400,
      strictPort: true,
      allowedHosts: ["localhost", ".localhost", ...extraHosts],
    },
  },
});
