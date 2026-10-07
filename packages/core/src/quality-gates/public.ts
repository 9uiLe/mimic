import type { Browser } from "@playwright/test";
import type { GateInput } from "./index.js";

export type * from "./index.js";

/** Keep optional lint and browser engines out of unrelated core consumers. */
export async function inspectBundle(input: GateInput) {
  return (await import("./index.js")).inspectBundle(input);
}

export async function runStaticQualityGates(input: GateInput) {
  return (await import("./index.js")).runStaticQualityGates(input);
}

export async function runBrowserQualityGates(
  input: GateInput,
  suppliedBrowser?: Browser,
) {
  return (await import("./browser.js")).runBrowserQualityGates(
    input,
    suppliedBrowser,
  );
}

export async function runStaticJourneyQualityGates(input: GateInput) {
  return (await import("./journey.js")).runStaticJourneyQualityGates(input);
}

export async function runBrowserJourneyQualityGates(
  input: GateInput,
  suppliedBrowser?: Browser,
) {
  return (await import("./journey-browser.js")).runBrowserJourneyQualityGates(
    input,
    suppliedBrowser,
  );
}
