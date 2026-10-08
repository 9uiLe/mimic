import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHROME_VERSION = "155.0.8059.39";
const root = fileURLToPath(new URL("../", import.meta.url));
const platforms = {
  "darwin-arm64": [
    "mac-arm64",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ],
  "darwin-x64": [
    "mac-x64",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ],
  "linux-arm64": ["linux-arm64", "chrome-linux-arm64/chrome"],
  "linux-x64": ["linux64", "chrome-linux64/chrome"],
};

function platform() {
  const selected = platforms[`${process.platform}-${process.arch}`];
  if (!selected)
    throw new Error("No verified Chrome for Testing build for this platform");
  return selected;
}

export function assertChromeVersion(version) {
  if (
    !new RegExp(
      `(?:^|\\s)${CHROME_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`,
    ).test(version)
  )
    throw new Error(
      `Expected patched Chrome for Testing ${CHROME_VERSION}; found ${version.trim()}`,
    );
}

export function verifyChromeExecutable(executable) {
  if (!executable)
    throw new Error("MIMIC_CHROME_EXECUTABLE is required for Chromium checks");
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" });
  assertChromeVersion(version);
  return version.trim();
}

export async function installChromeForTesting() {
  const [archivePlatform, binary] = platform();
  const cache = path.join(root, ".cache", "chrome-for-testing", CHROME_VERSION);
  const target = path.join(cache, archivePlatform);
  const executable = path.join(target, binary);
  if (!existsSync(executable)) {
    await mkdir(cache, { recursive: true });
    const temporary = await mkdtemp(path.join(cache, ".download-"));
    try {
      const archive = path.join(temporary, "chrome.zip");
      const extracted = path.join(temporary, "extracted");
      const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${archivePlatform}/chrome-${archivePlatform}.zip`;
      execFileSync(
        "curl",
        [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--output",
          archive,
          url,
        ],
        { stdio: "inherit" },
      );
      await mkdir(extracted);
      execFileSync("unzip", ["-q", archive, "-d", extracted], {
        stdio: "inherit",
      });
      verifyChromeExecutable(path.join(extracted, binary));
      try {
        await rename(extracted, target);
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(error.code) ||
          !existsSync(executable)
        )
          throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const version = verifyChromeExecutable(executable);
  process.stderr.write(`Verified ${version} at ${executable}\n`);
  return executable;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.stdout.write(`${await installChromeForTesting()}\n`);
