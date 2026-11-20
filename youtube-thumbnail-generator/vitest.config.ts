import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? "silent" },
    // Inlined so the tests' mock of `@seclai/sdk` reaches the handlers' own import of it.
    server: { deps: { inline: ["@seclai/handlers"] } },
  },
});
