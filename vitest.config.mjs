import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mimic/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/cli/tests/**/*.test.ts",
      "apps/demo-lab/src/catalog.test.ts",
      "scripts/check-yaml.test.mjs",
    ],
  },
});
