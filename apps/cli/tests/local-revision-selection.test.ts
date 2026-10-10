import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  FileWorkspaceStorage,
  type RegistryState,
  type RevisionSelectionRequest,
} from "@mimic/core";
import {
  LocalRevisionSelectionAuthority,
  type LocalRevisionSelectionConfirmation,
} from "../src/local-revision-selection.js";
import { LocalConfirmationAuthority } from "../src/local-confirmation-authority.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const ref = (id: string) => ({
  artifactId: id,
  revision: 1,
  lockDigest: `sha256:${"a".repeat(64)}`,
});
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

test("working-base confirmation binds the human, exact candidate, S11 review, and request ID across processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-selection-"));
  roots.push(root);
  const authority = new LocalRevisionSelectionAuthority(root);
  const request: RevisionSelectionRequest = {
    id: "selection_1",
    runId: "run_1",
    ref: ref("art_direction"),
    reviewRef: ref("art_review"),
    actor: { kind: "human", id: "person_1" },
    at: "2026-10-10T04:10:00Z",
    reason: "Revise this working direction",
  };
  const state = {
    runs: { run_1: { scope: "org_local" } },
  } as unknown as RegistryState;
  const confirmation: LocalRevisionSelectionConfirmation = {
    version: 1,
    action: "select-revision-base",
    hostId: "trusted-host",
    humanActorId: "person_1",
    confirmedAt: "2026-10-10T04:09:00Z",
    runId: "run_1",
    scopeOwnerId: "org_local",
    requestId: request.id,
    requestDigest: digest(request),
    candidate: request.ref,
    review: request.reviewRef,
  };
  const marked = await authority.prepare(request, confirmation, state);
  expect(
    await new LocalRevisionSelectionAuthority(root).verify(marked, state),
  ).toBe(true);
  expect(
    await new LocalConfirmationAuthority(
      new FileWorkspaceStorage(path.join(root, ".mimic/workspace.json")),
      root,
    ).verifyRevisionSelection(marked, state),
  ).toBe(true);
  expect(
    await authority.verify({ ...marked, ref: ref("art_other") }, state),
  ).toBe(false);
  expect(
    await authority.verify({ ...marked, reviewRef: ref("art_other") }, state),
  ).toBe(false);
  expect(
    await authority.verify(
      { ...marked, actor: { kind: "human", id: "other" } },
      state,
    ),
  ).toBe(false);
  expect(await authority.verify({ ...marked, externalRefs: [] }, state)).toBe(
    false,
  );
  await expect(
    authority.prepare(
      {
        ...request,
        id: "selection_2",
        externalRefs: ["mimic-local-revision-selection:forged"],
      },
      confirmation,
      state,
    ),
  ).rejects.toThrow(/markers/);
  await expect(
    authority.prepare(
      request,
      { ...confirmation, candidate: ref("art_other") },
      state,
    ),
  ).rejects.toThrow(/exact working selection/);
  await expect(
    authority.prepare(
      { ...request, ref: ref("art_other") },
      {
        ...confirmation,
        candidate: ref("art_other"),
        requestDigest: digest({ ...request, ref: ref("art_other") }),
      },
      state,
    ),
  ).rejects.toThrow(/changed request/);
});
