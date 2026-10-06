import { runCli } from "./cli.js";
import {
  loadOperatorTrustRoot,
  type OperatorTrust,
} from "./receipt-authority.js";

/** Production passes the fixed-path loader; injection is for trusted hosts and tests. */
export async function dispatchCli(
  argv: string[],
  loadTrust: () => Promise<OperatorTrust | undefined> = loadOperatorTrustRoot,
): Promise<number> {
  try {
    const operatorTrust = argv.length ? await loadTrust() : undefined;
    return await runCli(argv, undefined, { operatorTrust });
  } catch (error) {
    console.error(
      `MIMIC_4: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 4;
  }
}
