#!/usr/bin/env node
import { runCli } from "./cli.js";
import { loadOperatorTrustRoot } from "./receipt-authority.js";

const argv = process.argv.slice(2);
try {
  const operatorTrust = argv.length ? await loadOperatorTrustRoot() : undefined;
  process.exitCode = await runCli(argv, undefined, { operatorTrust });
} catch (error) {
  console.error(
    `MIMIC_4: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 4;
}
