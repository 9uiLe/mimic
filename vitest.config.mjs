import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/cli/tests/**/*.test.ts",
      "scripts/check-yaml.test.mjs",
    ],
  },
});
