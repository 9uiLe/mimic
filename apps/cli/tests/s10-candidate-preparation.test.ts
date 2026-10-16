import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { artifactDigest, type ArtifactSnapshot } from "@mimic/core";
import {
  HOST_DERIVED_DIGEST,
  prepareCodexWorkEnvelope,
} from "../src/agent/session-cli.js";
import type { TaskBinding } from "../src/agent/session.js";

const task: TaskBinding = {
  taskId: "s10",
  inputDigest: "input",
  packageDigest: "package",
  packageVersion: "0.1.2",
  contextDigest: "context",
  inputRefs: [],
};
type CandidateEnvelope = {
  artifacts: Array<{ content: { selectionStatus?: string } }>;
  work: { result: { outputRefs: Array<{ lockDigest: string }> } };
};

async function modelOutput(status?: string) {
  const example = JSON.parse(
    await readFile(
      "skills/s10-design-direction-generator/examples/directions.json",
      "utf8",
    ),
  );
  const artifact = structuredClone(example.candidate);
  if (status === undefined) delete artifact.content.selectionStatus;
  else artifact.content.selectionStatus = status;
  return JSON.stringify({
    artifacts: [artifact],
    work: {
      result: {
        runId: "run_design_example",
        taskId: "s10",
        skillId: "mimic.s10.design-direction-generator",
        inputRefs: [],
        outputRefs: [
          {
            artifactId: artifact.meta.id,
            revision: artifact.meta.revision,
            lockDigest: HOST_DERIVED_DIGEST,
          },
        ],
      },
    },
  });
}

test("S10 derives only missing candidate state and binds the resulting digest", async () => {
  const raw = await modelOutput();
  const original = prepareCodexWorkEnvelope(
    raw,
    task,
    false,
  ) as CandidateEnvelope;
  const prepared = prepareCodexWorkEnvelope(raw, task) as CandidateEnvelope;
  expect(original.artifacts[0].content.selectionStatus).toBeUndefined();
  expect(prepared.artifacts[0].content.selectionStatus).toBe("candidate");
  expect(prepared.work.result.outputRefs[0].lockDigest).toBe(
    artifactDigest(prepared.artifacts[0] as unknown as ArtifactSnapshot),
  );
  expect(JSON.parse(raw).artifacts[0].content.selectionStatus).toBeUndefined();
});

test("explicit status and other tasks are never rewritten", async () => {
  const selected = await modelOutput("selected");
  expect(
    (prepareCodexWorkEnvelope(selected, task) as CandidateEnvelope).artifacts[0]
      .content.selectionStatus,
  ).toBe("selected");
  const missing = await modelOutput();
  expect(
    (
      prepareCodexWorkEnvelope(missing, {
        ...task,
        taskId: "s09",
      }) as CandidateEnvelope
    ).artifacts[0].content.selectionStatus,
  ).toBeUndefined();
});
