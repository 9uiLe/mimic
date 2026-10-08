import { spawn } from "node:child_process";
import { installChromeForTesting } from "./chrome-for-testing.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Command required after with-patched-chrome.mjs");
const executable = await installChromeForTesting();
const child = spawn(command, args, {
  env: { ...process.env, MIMIC_CHROME_EXECUTABLE: executable },
  stdio: "inherit",
});
child.on("error", (error) => {
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
