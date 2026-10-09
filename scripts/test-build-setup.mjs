import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Finish compiled subprocess prerequisites before any Vitest worker can read
 * them. Force rebuilding also restores missing output on standalone cold runs. */
export default function setup() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const built = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "-b",
      "apps/cli",
      "--force",
    ],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  if (built.error || built.status !== 0)
    throw new Error(
      `Test subprocess build failed: ${built.error?.message || built.stderr || built.stdout || `exit ${built.status}, signal ${built.signal}`}`,
    );
}
