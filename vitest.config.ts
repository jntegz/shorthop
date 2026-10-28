import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            API_TOKEN: "test-api-token-0123456789abcdef",
            VISITOR_SALT: "test-salt",
            CF_ACCOUNT_ID: "",
            CF_ANALYTICS_TOKEN: "",
            // Tests serve the admin from the primary domain unless they set ADMIN_HOST,
            // and set up Access themselves.
            ADMIN_HOST: "",
            ACCESS_TEAM_DOMAIN: "",
            ACCESS_AUD: "",
            DEV_AUTH_BYPASS: "",
            // Tests that need the password login set ADMIN_PASSWORD_HASH themselves.
            ADMIN_PASSWORD_HASH: "",
            SESSION_SECRET: "test-session-secret-0123456789abcdef",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      // Node-side tests (the setup wizard) run with tsx --test.
      exclude: ["test/node/**"],
      setupFiles: ["./test/setup.ts"],
      // Every file runs in parallel in workerd, so a test that takes half a second alone can take several under load.
      testTimeout: 20_000,
    },
  };
});
