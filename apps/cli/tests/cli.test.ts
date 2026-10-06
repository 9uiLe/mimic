import { afterEach, describe, expect, test } from "vitest";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDigest,
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  type ArtifactSnapshot,
  type RegistryAuthority,
} from "@mimic/core";
import { EXIT, runCli, type CliHost } from "../src/cli.js";
import { atomicCreateJson } from "../src/atomic-file.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "mimic-cli-"));
  roots.push(value);
  return value;
}
const task = {
  id: "task_a",
  skillId: "skill.a",
  outputType: "design-system-asset",
  scopeOwnerId: "org_local",
  inputs: { required: [], optional: [], alternatives: [] },
  intent: "create",
  authority: "AUTONOMOUS",
};
async function call(args: string[], host: CliHost = {}) {
  const stdout: string[] = [],
    stderr: string[] = [];
  const code = await runCli(
    args,
    { out: (v) => stdout.push(v), err: (v) => stderr.push(v) },
    host,
  );
  return {
    code,
    stdout,
    stderr,
    value: stdout.length
      ? (JSON.parse(stdout.at(-1)!) as Record<string, unknown>)
      : undefined,
  };
}
async function initialized() {
  const dir = await root();
  expect((await call(["init", "--root", dir, "--json"])).code).toBe(EXIT.OK);
  await writeFile(path.join(dir, "tasks.json"), JSON.stringify([task]));
  return dir;
}

describe("CLI filesystem protocol", () => {
  test("keeps no-argument startup, initializes, reopens, and rejects corrupt state", async () => {
    expect((await call([])).value).toEqual({ name: "mimic", state: "ready" });
    const dir = await initialized();
    expect((await call(["init", "--root", dir, "--json"])).code).toBe(EXIT.OK);
    const started = await call([
      "run",
      "--root",
      dir,
      "--tasks",
      "tasks.json",
      "--id",
      "run_alpha",
      "--json",
    ]);
    expect(started.code).toBe(EXIT.OK);
    expect(started.value?.actions).toEqual([
      { taskId: "task_a", action: "GENERATE" },
    ]);
    expect(started.value?.path).toMatch(/^\.mimic\/outputs\/.*\.json$/);
    const detail = JSON.parse(
      await readFile(path.join(dir, started.value!.path as string), "utf8"),
    );
    expect(detail.actions[0].invocation.skillId).toBe("skill.a");
    const reopened = await call(["status", "--root", dir, "--json"]);
    expect(reopened.value?.runs).toEqual([
      { id: "run_alpha", state: "active" },
    ]);
    await writeFile(path.join(dir, ".mimic/workspace.json"), "{broken");
    const corrupt = await call(["status", "--root", dir, "--json"]);
    expect(corrupt.code).toBe(EXIT.IO);
    expect(corrupt.stderr[0]).toContain("MIMIC_6");
  });

  test("uses stable run IDs for retries and rejects changed plans", async () => {
    const dir = await initialized();
    const args = [
      "run",
      "--root",
      dir,
      "--tasks",
      "tasks.json",
      "--id",
      "run_retry",
      "--json",
    ];
    expect((await call(args)).code).toBe(EXIT.OK);
    expect((await call(args)).code).toBe(EXIT.OK);
    expect(
      (await call(["next", "run_retry", "--root", dir, "--json"])).value?.runId,
    ).toBe("run_retry");
    await writeFile(
      path.join(dir, "tasks.json"),
      JSON.stringify([{ ...task, id: "other" }]),
    );
    expect((await call(args)).code).toBe(EXIT.CONFLICT);
  });

  test("preflights malformed task plans before persistent writes and accepts corrected retry", async () => {
    const dir = await initialized();
    const args = [
      "run",
      "--root",
      dir,
      "--tasks",
      "tasks.json",
      "--id",
      "run_preflight",
      "--json",
    ];
    const invalid = [
      { ...task, skillId: "Bad Skill" },
      { ...task, scopeOwnerId: "outside" },
      { ...task, dependsOn: ["missing"] },
      { ...task, dependsOn: ["task_a"] },
      { ...task, inputs: { required: [null], optional: [], alternatives: [] } },
      {
        ...task,
        inputs: { required: [], optional: [], alternatives: [{ oneOf: [] }] },
      },
      { ...task, targetArtifactId: "../escape" },
      {
        ...task,
        uncertainties: [
          {
            kind: "blocking-unknown",
            reason: "Unknown",
            affectedTaskIds: ["missing"],
          },
        ],
      },
    ];
    for (const malformed of invalid) {
      await writeFile(
        path.join(dir, "tasks.json"),
        JSON.stringify([malformed]),
      );
      const result = await call(args);
      expect(result.code).toBe(EXIT.INVALID);
      expect(result.stdout).toEqual([]);
      expect(result.stderr[0]).toMatch(/^MIMIC_3:/);
      await expect(
        access(path.join(dir, ".mimic/runs/run_preflight.json")),
      ).rejects.toThrow();
      await expect(
        access(path.join(dir, ".mimic/workspace.json")),
      ).rejects.toThrow();
    }
    await writeFile(path.join(dir, "tasks.json"), JSON.stringify([task]));
    expect((await call(args)).code).toBe(EXIT.OK);
    expect((await call(args)).code).toBe(EXIT.OK);
    expect(
      (await call(["status", "--root", dir, "--json"])).value?.runs,
    ).toEqual([{ id: "run_preflight", state: "active" }]);
  });

  test("interrupted config and plan publication leaves no truncated final file", async () => {
    const dir = await root();
    for (const name of ["config.json", "run_atomic.json"]) {
      const file = path.join(dir, name);
      await expect(
        atomicCreateJson(file, { version: 1 }, (phase) => {
          if (phase === "before-link") throw new Error("interrupted");
        }),
      ).rejects.toThrow("interrupted");
      await expect(access(file)).rejects.toThrow();
      expect(
        (await readdir(dir)).filter((item) => item.endsWith(".pending")),
      ).toEqual([]);
      expect(await atomicCreateJson(file, { version: 1 })).toBe(true);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1 });
      expect(await atomicCreateJson(file, { version: 2 })).toBe(false);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1 });
    }
    const afterLink = path.join(dir, "after-link.json");
    await expect(
      atomicCreateJson(afterLink, { complete: true }, (phase) => {
        if (phase === "after-link") throw new Error("response lost");
      }),
    ).rejects.toThrow("response lost");
    expect(JSON.parse(await readFile(afterLink, "utf8"))).toEqual({
      complete: true,
    });
    expect(await atomicCreateJson(afterLink, { complete: true })).toBe(false);
  });

  test("contains input files and reports unsupported backends honestly", async () => {
    const dir = await initialized();
    const external = await root();
    await writeFile(path.join(external, "tasks.json"), JSON.stringify([task]));
    expect(
      (
        await call([
          "run",
          "--root",
          dir,
          "--tasks",
          path.join(external, "tasks.json"),
          "--json",
        ])
      ).code,
    ).toBe(EXIT.INVALID);
    await symlink(
      path.join(external, "tasks.json"),
      path.join(dir, "outside-link.json"),
    );
    expect(
      (
        await call([
          "run",
          "--root",
          dir,
          "--tasks",
          "outside-link.json",
          "--json",
        ])
      ).code,
    ).toBe(EXIT.INVALID);
    expect(
      (
        await call([
          "submit",
          "run_missing",
          "--task",
          "task_a",
          "--root",
          dir,
          "--json",
        ])
      ).code,
    ).toBe(EXIT.UNSUPPORTED);
    expect((await call(["preview", "--root", dir, "--json"])).code).toBe(
      EXIT.UNSUPPORTED,
    );
    expect((await call(["release", "--root", dir, "--json"])).code).toBe(
      EXIT.UNSUPPORTED,
    );
    expect(
      (await call(["decide", "--file", "tasks.json", "--root", dir, "--json"]))
        .code,
    ).toBe(EXIT.USAGE);
  });

  test("schema validation reports its boundary with file-backed diagnostics", async () => {
    const dir = await initialized();
    const invalid = await call([
      "validate",
      "--root",
      dir,
      "--file",
      "tasks.json",
      "--json",
    ]);
    expect(invalid.code).toBe(EXIT.INVALID);
    expect(invalid.value?.level).toBe("schema-only");
    expect(invalid.value?.path).toMatch(/^\.mimic\/outputs\//);
    expect(
      Array.isArray(
        JSON.parse(
          await readFile(path.join(dir, invalid.value!.path as string), "utf8"),
        ),
      ),
    ).toBe(true);
  });

  test("an actor label alone cannot record a deferred human decision", async () => {
    const dir = await initialized();
    expect(
      (
        await call([
          "run",
          "--root",
          dir,
          "--tasks",
          "tasks.json",
          "--id",
          "run_auth",
          "--json",
        ])
      ).code,
    ).toBe(EXIT.OK);
    const workspace = new FileWorkspaceStorage(
      path.join(dir, ".mimic/workspace.json"),
    );
    const schemas = await loadSchemaDirectory(
      path.join(repo, "schemas/artifacts"),
    );
    const authority: RegistryAuthority = {
      async verify(record) {
        return (
          record.id === "decision_trusted" &&
          record.actor.id === "human_trusted"
        );
      },
      async allowCommit() {
        return false;
      },
    };
    const runtime = createOrchestratorRuntime(
      workspace,
      schemas,
      [{ level: "organization", ownerId: "org_local" }],
      authority,
    );
    const candidate = JSON.parse(
      await readFile(
        path.join(repo, "fixtures/artifacts/valid/design-system-asset.json"),
        "utf8",
      ),
    ) as ArtifactSnapshot;
    const artifact: ArtifactSnapshot = {
      ...candidate,
      meta: { ...candidate.meta, id: "art_cli_candidate" },
      scope: { level: "organization", ownerId: "org_local" },
      lifecycle: { status: "proposed", freshness: "valid" },
      origin: { ...candidate.origin, runId: "run_auth" },
    };
    const ref = {
      artifactId: artifact.meta.id,
      revision: artifact.meta.revision,
      lockDigest: artifactDigest(artifact),
    };
    await runtime.artifacts.create(artifact);
    await runtime.registry.produce({
      runId: "run_auth",
      ref,
      inputs: [],
      actor: { kind: "agent", id: "cli" },
      at: new Date().toISOString(),
      reason: "Stage review",
    });
    await runtime.registry.submit({
      runId: "run_auth",
      packetId: "packet_auth",
      proposals: [
        {
          id: "proposal_auth",
          ref,
          alternatives: ["accept", "reject"],
          rationale: "Review",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: { kind: "agent", id: "cli" },
      at: new Date().toISOString(),
      reason: "Review",
    });
    const forged = {
      id: "decision_forged",
      packetId: "packet_auth",
      proposalId: "proposal_auth",
      outcome: "deferred",
      actor: { kind: "human", id: "human_trusted" },
      at: new Date().toISOString(),
      rationale: "Wait",
    };
    await writeFile(path.join(dir, "decision.json"), JSON.stringify(forged));
    expect(
      (
        await call([
          "decide",
          "--root",
          dir,
          "--file",
          "decision.json",
          "--json",
        ])
      ).code,
    ).toBe(EXIT.USAGE);
    expect(
      (
        await call(
          ["decide", "--root", dir, "--file", "decision.json", "--json"],
          { authority },
        )
      ).code,
    ).toBe(EXIT.INVALID);
    await writeFile(
      path.join(dir, "decision.json"),
      JSON.stringify({ ...forged, id: "decision_trusted" }),
    );
    expect(
      (
        await call(
          ["decide", "--root", dir, "--file", "decision.json", "--json"],
          { authority },
        )
      ).code,
    ).toBe(EXIT.OK);
    expect(
      (
        await call(
          ["decide", "--root", dir, "--file", "decision.json", "--json"],
          { authority },
        )
      ).code,
    ).toBe(EXIT.OK);
    expect(
      (await call(["decisions", "--root", dir, "--json"])).value?.packets,
    ).toMatchObject([
      {
        id: "packet_auth",
        proposals: [{ status: "pending", readiness: "blocked" }],
      },
    ]);
  });
});
