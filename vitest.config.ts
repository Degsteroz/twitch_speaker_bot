import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["{packages,services}/*/src/**/*.ts"],
      exclude: ["**/index.ts"]
    },
    include: ["{packages,services,apps}/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true
  }
});
