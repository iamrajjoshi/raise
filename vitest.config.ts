import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["apps/mcp/src/**/*.ts", "apps/server/src/**/*.ts", "packages/protocol/src/**/*.ts"],
    },
  },
});
