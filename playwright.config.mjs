import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "apps/demo-lab/tests",
  use: { baseURL: "http://127.0.0.1:4173" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @mimic/demo-lab dev --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
