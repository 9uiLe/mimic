import { defineConfig, devices } from "@playwright/test";

const patchedChrome = process.env.MIMIC_CHROME_EXECUTABLE;

function chromiumOptions() {
  return {
    launchOptions: {
      executablePath: patchedChrome ?? "/missing-patched-chrome",
    },
  };
}

export default defineConfig({
  testDir: "apps/demo-lab/tests",
  use: { baseURL: "http://127.0.0.1:4173" },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], ...chromiumOptions() },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 7"], ...chromiumOptions() },
    },
    { name: "firefox-desktop", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"] } },
    { name: "webkit-mobile", use: { ...devices["iPhone 15"] } },
  ],
  globalSetup: "./scripts/verify-playwright-chrome.mjs",
  webServer: {
    command: "pnpm --filter @mimic/demo-lab dev --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
