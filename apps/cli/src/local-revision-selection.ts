// The existing cooperative controlling host supplies this explicit human confirmation.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  type ExactArtifactRef,
  type RegistryState,
  type RevisionSelectionRequest,
} from "@mimic/core";
import { atomicCreateJson } from "./atomic-file.js";

const marker = "mimic-local-revision-selection:";
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const name = (value: string) => {
  if (!/^sha256:[0-9a-f]{64}$/.test(value))
    throw Error("Invalid selection digest");
  return `${value.slice(7)}.json`;
};

export interface LocalRevisionSelectionConfirmation {
  readonly version: 1;
  readonly action: "select-revision-base";
  readonly hostId: string;
  readonly humanActorId: string;
  readonly confirmedAt: string;
  readonly runId: string;
  readonly scopeOwnerId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly candidate: ExactArtifactRef;
  readonly review: ExactArtifactRef;
  readonly supersedesSelectionId?: string;
  readonly conversationRef?: string;
}

export class LocalRevisionSelectionAuthority {
  constructor(private readonly root: string) {}
  private folder() {
    return path.join(
      this.root,
      ".mimic",
      "confirmations",
      "revision-selections",
    );
  }
  private async readStored(file: string): Promise<unknown> {
    const root = await realpath(this.root);
    const resolved = await realpath(file);
    const metadata = await lstat(file);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !resolved.startsWith(`${root}${path.sep}`)
    )
      throw Error("Selection confirmation escapes workspace");
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  }
  private binds(
    c: LocalRevisionSelectionConfirmation,
    request: RevisionSelectionRequest,
    state: RegistryState,
  ): boolean {
    const run = state.runs[request.runId];
    const refs = request.externalRefs ?? [];
    const unmarked = { ...request } as { externalRefs?: readonly string[] };
    delete unmarked.externalRefs;
    return !!(
      c &&
      Object.keys(c).every((key) =>
        [
          "version",
          "action",
          "hostId",
          "humanActorId",
          "confirmedAt",
          "runId",
          "scopeOwnerId",
          "requestId",
          "requestDigest",
          "candidate",
          "review",
          "supersedesSelectionId",
          "conversationRef",
        ].includes(key),
      ) &&
      c.version === 1 &&
      c.action === "select-revision-base" &&
      c.hostId?.trim() &&
      c.humanActorId === request.actor.id &&
      request.actor.kind === "human" &&
      c.runId === request.runId &&
      c.scopeOwnerId === run?.scope &&
      c.requestId === request.id &&
      c.requestDigest === digest(unmarked) &&
      same(c.candidate, request.ref) &&
      same(c.review, request.reviewRef) &&
      c.supersedesSelectionId === request.supersedesSelectionId &&
      (c.conversationRef === undefined || !!c.conversationRef.trim()) &&
      Number.isFinite(Date.parse(c.confirmedAt)) &&
      Date.parse(c.confirmedAt) <= Date.parse(request.at) &&
      Date.parse(c.confirmedAt) <= Date.now() &&
      refs.length === 1 &&
      refs[0] === `${marker}${digest(c)}`
    );
  }
  async prepare(
    request: RevisionSelectionRequest,
    c: LocalRevisionSelectionConfirmation,
    state: RegistryState,
  ): Promise<RevisionSelectionRequest> {
    if (request.externalRefs?.length)
      throw Error("Caller cannot supply selection authority markers");
    const marked: RevisionSelectionRequest = {
      ...request,
      externalRefs: [`${marker}${digest(c)}`],
    };
    if (!this.binds(c, marked, state))
      throw Error("Confirmation does not bind exact working selection");
    const folder = this.folder();
    const ids = path.join(folder, "ids");
    await mkdir(ids, { recursive: true });
    const root = await realpath(this.root);
    for (const directory of [folder, ids])
      if (!(await realpath(directory)).startsWith(`${root}${path.sep}`))
        throw Error("Selection confirmation store escapes workspace");
    const confirmationDigest = digest(c);
    await atomicCreateJson(path.join(folder, name(confirmationDigest)), c);
    const binding = { requestDigest: c.requestDigest, confirmationDigest };
    const file = path.join(ids, name(digest(request.id)));
    if (
      !(await atomicCreateJson(file, binding)) &&
      !same(await this.readStored(file), binding)
    )
      throw Error("Selection ID changed request");
    return marked;
  }
  async verify(
    request: RevisionSelectionRequest,
    state: RegistryState,
  ): Promise<boolean> {
    try {
      const refs = request.externalRefs ?? [];
      if (refs.length !== 1 || !refs[0]?.startsWith(marker)) return false;
      const value = refs[0].slice(marker.length);
      const c = (await this.readStored(
        path.join(this.folder(), name(value)),
      )) as LocalRevisionSelectionConfirmation;
      if (digest(c) !== value || !this.binds(c, request, state)) return false;
      return same(
        await this.readStored(
          path.join(this.folder(), "ids", name(digest(request.id))),
        ),
        { requestDigest: c.requestDigest, confirmationDigest: value },
      );
    } catch {
      return false;
    }
  }
}
