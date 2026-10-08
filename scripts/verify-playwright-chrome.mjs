import { chromium } from "@playwright/test";
import {
  assertChromeVersion,
  verifyChromeExecutable,
} from "./chrome-for-testing.mjs";

export default async function verifyPlaywrightChrome() {
  const executable = process.env.MIMIC_CHROME_EXECUTABLE;
  verifyChromeExecutable(executable);
  const browser = await chromium.launch({
    executablePath: executable,
    headless: true,
  });
  try {
    assertChromeVersion(browser.version());
    process.stderr.write(
      `Playwright launched Chrome for Testing ${browser.version()}\n`,
    );
  } finally {
    await browser.close();
  }
}
