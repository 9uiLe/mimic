import {
  buildPrototype,
  buildPrototypeModes,
  runStaticQualityGates,
  runBrowserQualityGates,
  type ArtifactStore,
  type PrototypeBuilderInput,
  type PrototypeModePlan,
  type QualityReport,
} from "@mimic/core";

export interface PreviewPlan {
  readonly kind: "standalone" | "modes";
  readonly plan: PrototypeBuilderInput | PrototypeModePlan;
  readonly uiContract?: {
    readonly artifactId: string;
    readonly revision: number;
    readonly lockDigest: string;
  };
}
export class CliPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliPreviewError";
  }
}

export async function createPreview(
  root: string,
  store: ArtifactStore,
  input: PreviewPlan,
  browser: boolean,
): Promise<{
  directories: readonly string[];
  reports: readonly QualityReport[];
  fallback?: string;
}> {
  if (
    !input ||
    !["standalone", "modes"].includes(input.kind) ||
    !input.plan ||
    typeof input.plan !== "object" ||
    Array.isArray(input.plan)
  )
    throw new CliPreviewError("Invalid authored preview plan");
  const result =
    input.kind === "standalone"
      ? {
          directories: [
            (
              await buildPrototype(
                store,
                input.plan as PrototypeBuilderInput,
                root,
              )
            ).directory,
          ],
          fallback: undefined,
        }
      : await (async () => {
          const value = await buildPrototypeModes(
            store,
            input.plan as PrototypeModePlan,
            root,
          );
          return {
            directories: [
              value.current.directory,
              ...(value.proposed ? [value.proposed.directory] : []),
            ],
            fallback: value.fallback,
          };
        })();
  const reports: QualityReport[] = [];
  for (const directory of result.directories) {
    const gateInput = {
      trustedRoot: root,
      directory,
      store,
      uiContract: input.uiContract,
    };
    reports.push((await runStaticQualityGates(gateInput)).report);
    if (browser) reports.push(await runBrowserQualityGates(gateInput));
  }
  return { ...result, reports };
}
