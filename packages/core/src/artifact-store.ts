import {
  open,
  mkdir,
  readdir,
  readFile,
  realpath,
  link,
  lstat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  artifactDigest,
  CANONICALIZATION_VERSION,
  canonicalJson,
  jsonCopy,
  type JsonValue,
} from "./artifact-canonical.js";
import type { SchemaRegistry } from "./schema-registry.js";

const ID = /^art_[A-Za-z0-9_-]+$/;
const LEVELS = ["organization", "product", "domain", "local"] as const;
export type ScopeLevel = (typeof LEVELS)[number];

export interface ScopeNode {
  readonly level: ScopeLevel;
  readonly ownerId: string;
  readonly parentId?: string;
}

export interface ArtifactSnapshot {
  readonly meta: {
    readonly id: string;
    readonly type: string;
    readonly schemaVersion: string;
    readonly revision: number;
    readonly supersedesRevision?: number;
    readonly contentDigest?: string;
    readonly [key: string]: JsonValue | undefined;
  };
  readonly scope: ScopeNode;
  readonly lifecycle: {
    readonly status: "provisional" | "proposed" | "approved" | "rejected";
    readonly [key: string]: JsonValue | undefined;
  };
  readonly approval: {
    readonly status: "pending" | "approved" | "rejected";
    readonly decisionId?: string;
    readonly actorId?: string;
    readonly at?: string;
  };
  readonly dependencies: readonly {
    readonly artifactId: string;
    readonly revision: number;
    readonly lockDigest: string;
    readonly onChange: string;
  }[];
  readonly provenance: readonly {
    readonly path: string;
    readonly kind: string;
    readonly decisionId?: string;
    readonly rationale?: string;
    readonly [key: string]: JsonValue | undefined;
  }[];
  readonly content: JsonValue;
  readonly [key: string]: unknown;
}

export interface AuthorityVerifier {
  verifyApproval(
    approval: ArtifactSnapshot["approval"],
    artifact: ArtifactSnapshot,
  ): Promise<boolean>;
  verifyDecision(
    decisionId: string,
    artifact: ArtifactSnapshot,
  ): Promise<boolean>;
}

/** Storage publishes opaque complete records and never overwrites an exact revision. */
export interface SnapshotStorage {
  read(id: string, revision: number): Promise<string | undefined>;
  revisions(id: string): Promise<readonly number[]>;
  writeIfAbsent(id: string, revision: number, record: string): Promise<boolean>;
}

export class ArtifactStoreError extends Error {
  constructor(
    readonly code:
      "INVALID" | "CONFLICT" | "UNAVAILABLE" | "CORRUPT" | "UNVERIFIED",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

function assertId(id: string): void {
  if (!ID.test(id))
    throw new ArtifactStoreError("INVALID", `Invalid artifact ID: ${id}`);
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new ArtifactStoreError("INVALID", `Invalid revision: ${revision}`);
}

export class FileSnapshotStorage implements SnapshotStorage {
  constructor(readonly root: string) {}

  private async directory(id: string, create: boolean): Promise<string> {
    assertId(id);
    if (create) await mkdir(this.root, { recursive: true });
    let base: string;
    try {
      base = await realpath(this.root);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT")
        return path.join(path.resolve(this.root), id);
      throw error;
    }
    const candidate = path.join(base, id);
    if (create) await mkdir(candidate, { recursive: true });
    let actual: string;
    try {
      actual = await realpath(candidate);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT")
        return candidate;
      throw error;
    }
    if (actual !== candidate)
      throw new ArtifactStoreError(
        "INVALID",
        "Artifact directory escapes storage root",
      );
    return actual;
  }

  async read(id: string, revision: number): Promise<string | undefined> {
    assertRevision(revision);
    const directory = await this.directory(id, false);
    try {
      const file = path.join(directory, `${revision}.json`);
      if (!(await lstat(file)).isFile())
        throw new ArtifactStoreError(
          "CORRUPT",
          "Snapshot is not a regular file",
        );
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async revisions(id: string): Promise<readonly number[]> {
    const directory = await this.directory(id, false);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (
      names.some(
        (name) =>
          name.endsWith(".json") &&
          (!/^[1-9][0-9]*\.json$/.test(name) ||
            !Number.isSafeInteger(Number(name.slice(0, -5)))),
      )
    )
      throw new ArtifactStoreError(
        "CORRUPT",
        `Invalid revision filename for ${id}`,
      );
    return names
      .filter((name) => /^[1-9][0-9]*\.json$/.test(name))
      .map((name) => Number(name.slice(0, -5)))
      .sort((a, b) => a - b);
  }

  async writeIfAbsent(
    id: string,
    revision: number,
    record: string,
  ): Promise<boolean> {
    assertRevision(revision);
    const directory = await this.directory(id, true);
    const temporary = path.join(directory, `.${randomUUID()}.pending`);
    const destination = path.join(directory, `${revision}.json`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(record, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination); // Same-directory hard link: atomic and fails if another writer won.
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await unlink(temporary);
    }
  }
}

interface StoredRecord {
  readonly canonicalization: string;
  readonly digest: string;
  readonly artifact: ArtifactSnapshot;
}

function pointerExists(artifact: ArtifactSnapshot, pointer: string): boolean {
  if (!pointer.startsWith("/content")) return false;
  let current: unknown = artifact;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(encoded)) return false;
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)
        return false;
      current = current[Number(key)];
    } else if (
      current &&
      typeof current === "object" &&
      Object.hasOwn(current, key)
    ) {
      current = (current as Record<string, unknown>)[key];
    } else return false;
  }
  return true;
}

export class ArtifactStore {
  private readonly scopes = new Map<string, ScopeNode>();
  constructor(
    readonly storage: SnapshotStorage,
    readonly schemas: SchemaRegistry,
    scopes: readonly ScopeNode[],
    readonly authority?: AuthorityVerifier,
  ) {
    for (const scope of scopes) {
      if (this.scopes.has(scope.ownerId))
        throw new Error(`Duplicate scope owner: ${scope.ownerId}`);
      this.scopes.set(scope.ownerId, jsonCopy(scope));
    }
    for (const scope of this.scopes.values()) this.ancestry(scope);
  }

  private ancestry(scope: ScopeNode): string[] {
    const chain: string[] = [];
    let current: ScopeNode | undefined = scope;
    for (let index = LEVELS.indexOf(scope.level); index >= 0; index--) {
      if (
        !current ||
        current.level !== LEVELS[index] ||
        chain.includes(current.ownerId)
      )
        throw new ArtifactStoreError(
          "INVALID",
          `Invalid scope ancestry: ${scope.ownerId}`,
        );
      chain.push(current.ownerId);
      current = current.parentId
        ? this.scopes.get(current.parentId)
        : undefined;
    }
    if (current || (scope.level === "organization" && scope.parentId))
      throw new ArtifactStoreError(
        "INVALID",
        `Invalid scope root: ${scope.ownerId}`,
      );
    return chain;
  }

  private async approvalVerified(artifact: ArtifactSnapshot): Promise<boolean> {
    if (!this.authority) return false;
    try {
      return await this.authority.verifyApproval(
        jsonCopy(artifact.approval),
        jsonCopy(artifact),
      );
    } catch {
      return false;
    }
  }

  private async decisionVerified(
    decisionId: string,
    artifact: ArtifactSnapshot,
  ): Promise<boolean> {
    if (!this.authority) return false;
    try {
      return await this.authority.verifyDecision(
        decisionId,
        jsonCopy(artifact),
      );
    } catch {
      return false;
    }
  }

  private async verify(artifact: ArtifactSnapshot): Promise<void> {
    const validation = this.schemas.validate(artifact);
    if (!validation.valid)
      throw new ArtifactStoreError(
        "INVALID",
        `Schema validation failed: ${JSON.stringify(validation.diagnostics)}`,
      );
    const registered = this.scopes.get(artifact.scope.ownerId);
    if (
      !registered ||
      canonicalJson(registered) !== canonicalJson(artifact.scope)
    )
      throw new ArtifactStoreError(
        "INVALID",
        "Artifact scope is not registered",
      );
    const ancestors = this.ancestry(registered);
    for (const dependency of artifact.dependencies) {
      if (dependency.artifactId === artifact.meta.id)
        throw new ArtifactStoreError(
          "INVALID",
          "Self dependency is not allowed",
        );
      const resolved = await this.read(
        dependency.artifactId,
        dependency.revision,
      );
      if (resolved.digest !== dependency.lockDigest)
        throw new ArtifactStoreError(
          "INVALID",
          "Dependency lock digest mismatch",
        );
      if (!ancestors.includes(resolved.artifact.scope.ownerId))
        throw new ArtifactStoreError(
          "INVALID",
          "Dependency scope is not an ancestor",
        );
    }
    for (const entry of artifact.provenance) {
      if (!pointerExists(artifact, entry.path))
        throw new ArtifactStoreError(
          "INVALID",
          `Unresolved provenance pointer: ${entry.path}`,
        );
      if (
        entry.kind === "human-decision" &&
        (!entry.decisionId ||
          !(await this.decisionVerified(entry.decisionId, artifact)))
      )
        throw new ArtifactStoreError(
          "UNVERIFIED",
          "Decision reference is not verified",
        );
    }
    if (artifact.approval.status !== "pending") {
      if (!(await this.approvalVerified(artifact)))
        throw new ArtifactStoreError(
          "UNVERIFIED",
          "Human approval is not verified",
        );
    }
  }

  async read(
    id: string,
    revision: number,
  ): Promise<{ artifact: ArtifactSnapshot; digest: string }> {
    assertId(id);
    assertRevision(revision);
    let raw: string | undefined;
    try {
      raw = await this.storage.read(id, revision);
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "UNAVAILABLE",
        `Cannot read snapshot ${id}@${revision}: ${String(error)}`,
      );
    }
    if (raw === undefined)
      throw new ArtifactStoreError(
        "UNAVAILABLE",
        `Snapshot unavailable: ${id}@${revision}`,
      );
    let record: StoredRecord;
    try {
      record = JSON.parse(raw) as StoredRecord;
    } catch {
      throw new ArtifactStoreError(
        "CORRUPT",
        `Unreadable snapshot: ${id}@${revision}`,
      );
    }
    try {
      if (
        record.canonicalization !== CANONICALIZATION_VERSION ||
        record.artifact.meta.id !== id ||
        record.artifact.meta.revision !== revision
      )
        throw new Error("Record identity or canonicalization mismatch");
      const digest = artifactDigest(record.artifact);
      if (
        record.digest !== digest ||
        (record.artifact.meta.contentDigest &&
          record.artifact.meta.contentDigest !== digest)
      )
        throw new Error("Snapshot digest mismatch");
      await this.verify(record.artifact);
      return { artifact: jsonCopy(record.artifact), digest };
    } catch (error) {
      if (
        error instanceof ArtifactStoreError &&
        (error.code === "UNVERIFIED" || error.code === "UNAVAILABLE")
      )
        throw error;
      throw new ArtifactStoreError(
        "CORRUPT",
        `Invalid snapshot ${id}@${revision}: ${String(error)}`,
      );
    }
  }

  async history(
    id: string,
  ): Promise<readonly { artifact: ArtifactSnapshot; digest: string }[]> {
    assertId(id);
    const revisions = await this.storage.revisions(id);
    const results = [];
    for (let index = 0; index < revisions.length; index++) {
      if (revisions[index] !== index + 1)
        throw new ArtifactStoreError(
          "CORRUPT",
          `Gap in revision history: ${id}`,
        );
      results.push(await this.read(id, index + 1));
    }
    return results;
  }

  async create(
    input: ArtifactSnapshot,
  ): Promise<{ artifact: ArtifactSnapshot; digest: string }> {
    const artifact = jsonCopy(input);
    assertId(artifact.meta.id);
    assertRevision(artifact.meta.revision);
    const digest = artifactDigest(artifact);
    if (artifact.meta.contentDigest && artifact.meta.contentDigest !== digest)
      throw new ArtifactStoreError(
        "INVALID",
        "Supplied content digest mismatch",
      );
    const existing = await this.storage.read(
      artifact.meta.id,
      artifact.meta.revision,
    );
    if (existing !== undefined) {
      const prior = await this.read(artifact.meta.id, artifact.meta.revision);
      if (canonicalJson(prior.artifact) === canonicalJson(artifact))
        return prior;
      throw new ArtifactStoreError(
        "CONFLICT",
        "Revision already exists with different bytes",
      );
    }
    await this.verify(artifact);
    const history = await this.history(artifact.meta.id);
    const latest = history.at(-1)?.artifact.meta.revision ?? 0;
    if (
      artifact.meta.revision !== latest + 1 ||
      (latest
        ? artifact.meta.supersedesRevision !== latest
        : artifact.meta.supersedesRevision !== undefined)
    ) {
      const raced = await this.storage.read(
        artifact.meta.id,
        artifact.meta.revision,
      );
      if (raced !== undefined) {
        const winner = await this.read(
          artifact.meta.id,
          artifact.meta.revision,
        );
        if (canonicalJson(winner.artifact) === canonicalJson(artifact))
          return winner;
      }
      throw new ArtifactStoreError(
        "CONFLICT",
        "Revision must follow latest snapshot and supersede it",
      );
    }
    if (latest) {
      const previous = history.at(-1)!;
      if (previous.artifact.meta.type !== artifact.meta.type)
        throw new ArtifactStoreError(
          "INVALID",
          "Artifact type cannot change across revisions",
        );
      if (
        canonicalJson(previous.artifact.scope) !== canonicalJson(artifact.scope)
      ) {
        if (
          !this.ancestry(previous.artifact.scope).includes(
            artifact.scope.ownerId,
          )
        )
          throw new ArtifactStoreError(
            "INVALID",
            "Scope may change only toward an ancestor",
          );
        if (artifact.approval.status !== "approved")
          throw new ArtifactStoreError(
            "UNVERIFIED",
            "Scope promotion requires verified approval",
          );
      }
    }
    const record = canonicalJson({
      canonicalization: CANONICALIZATION_VERSION,
      digest,
      artifact,
    });
    if (
      !(await this.storage.writeIfAbsent(
        artifact.meta.id,
        artifact.meta.revision,
        record,
      ))
    ) {
      const winner = await this.read(artifact.meta.id, artifact.meta.revision);
      if (canonicalJson(winner.artifact) === canonicalJson(artifact))
        return winner;
      throw new ArtifactStoreError(
        "CONFLICT",
        "Concurrent revision publication conflict",
      );
    }
    return { artifact: jsonCopy(artifact), digest };
  }
}
