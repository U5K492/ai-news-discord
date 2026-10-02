import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test-token",
      ADMIN_TOKEN: "test-admin-token"
    } }
  })],
  test: { include: ["tests/worker.test.ts"], fileParallelism: false }
});
