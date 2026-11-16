import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      { test: { name: "unit", include: ["**/*.test.ts", "**/*.test.tsx"] } },
      { test: { name: "integration", include: ["tests/integration/**/*.integration.test.ts"] } },
    ],
  },
});
