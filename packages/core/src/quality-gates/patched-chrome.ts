import type { Browser } from "@playwright/test";

const patchedVersion = "155.0.8059.39";

export class PatchedChromeError extends Error {}

export function patchedChromeLaunchOptions() {
  const executablePath = process.env.MIMIC_CHROME_EXECUTABLE;
  if (!executablePath)
    throw new PatchedChromeError(
      "MIMIC_CHROME_EXECUTABLE is required for Chromium checks",
    );
  return { executablePath, headless: true } as const;
}

export function assertPatchedChrome(browser: Browser) {
  if (browser.browserType().name() !== "chromium") return;
  if (browser.version() !== patchedVersion)
    throw new PatchedChromeError(
      `Expected patched Chrome for Testing ${patchedVersion}; found ${browser.version()}`,
    );
}
