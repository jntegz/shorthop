import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * wrangler.jsonc (written by `npm run setup`) when it exists. In Workers
 * Builds (a Deploy to Cloudflare install), the button's wrangler.toml.
 * Otherwise the example config, but only for the dev server or with
 * SHORTHOP_ALLOW_EXAMPLE_CONFIG=1 (CI), so a build can't be deployed with
 * placeholder values by accident.
 */
function wranglerConfig(command: "build" | "serve"): string {
  if (existsSync(r("./wrangler.jsonc"))) return r("./wrangler.jsonc");
  if (process.env.WORKERS_CI === "1") return r("./wrangler.toml");
  if (command === "serve" || process.env.SHORTHOP_ALLOW_EXAMPLE_CONFIG === "1") return r("./wrangler.example.jsonc");
  throw new Error("wrangler.jsonc is missing. Run `npm run setup` first (or set SHORTHOP_ALLOW_EXAMPLE_CONFIG=1 for a test build).");
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), cloudflare({ configPath: wranglerConfig(command) })],
  environments: {
    client: {
      build: {
        // The SPA entry lives at ./_admin/index.html, so the build lands in
        // dist/client/_admin/ and every bundle under /_admin/assets/.
        assetsDir: "_admin/assets",
        rolldownOptions: { input: r("./_admin/index.html") },
      },
    },
  },
}));
