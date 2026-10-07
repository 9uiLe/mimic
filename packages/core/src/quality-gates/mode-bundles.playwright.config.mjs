export default {
  testDir: import.meta.dirname,
  testMatch: "mode-bundles.browser.spec.mjs",
  timeout: 60_000,
  use: { browserName: "chromium" },
};
