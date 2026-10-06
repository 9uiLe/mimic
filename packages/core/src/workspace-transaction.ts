import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, jsonCopy } from "./artifact-canonical.js";
import type { SnapshotStorage } from "./artifact-store.js";
import type {
  RegistryState,
  TransactionalRegistryStorage,
} from "./run-registry/registry.js";

const activeTransactionViews = new WeakMap<SnapshotStorage, SnapshotStorage>();
export function isWorkspaceTransactionView(
  view: SnapshotStorage,
  owner: SnapshotStorage,
): boolean {
  return activeTransactionViews.get(view) === owner;
}

interface WorkspaceData {
  readonly version: 1;
  snapshots: Record<string, string>;
  registry: RegistryState;
}
export interface AtomicRegistryStorage extends TransactionalRegistryStorage {
  readonly snapshots: SnapshotStorage;
  transactWorkspace<T>(
    change: (registry: RegistryState, snapshots: SnapshotStorage) => Promise<T>,
  ): Promise<T>;
}
function initial(): WorkspaceData {
  return {
    version: 1,
    snapshots: {},
    registry: {
      canonical: {},
      freshness: {},
      runs: {},
      packets: {},
      decisions: {},
      commits: {},
      events: [],
    },
  };
}
function key(id: string, revision: number): string {
  return `${id}@${revision}`;
}
function revisionList(data: WorkspaceData, id: string): number[] {
  const prefix = `${id}@`;
  return Object.keys(data.snapshots)
    .filter((name) => name.startsWith(prefix))
    .map((name) => Number(name.slice(prefix.length)))
    .sort((a, b) => a - b);
}
function view(data: WorkspaceData): SnapshotStorage {
  return {
    async read(id, revision) {
      return data.snapshots[key(id, revision)];
    },
    async revisions(id) {
      return revisionList(data, id);
    },
    async writeIfAbsent(id, revision, record) {
      const name = key(id, revision);
      if (Object.hasOwn(data.snapshots, name)) return false;
      data.snapshots[name] = record;
      return true;
    },
  };
}
/** A single visibility unit for artifact records and Run/Decision/canonical state. */
export class FileWorkspaceStorage implements AtomicRegistryStorage {
  readonly snapshots: SnapshotStorage = {
    read: async (id, revision) =>
      (await this.load()).snapshots[key(id, revision)],
    revisions: async (id) => revisionList(await this.load(), id),
    writeIfAbsent: (id, revision, record) =>
      this.transactWorkspace(async (_registry, snapshots) => {
        const revisions = await snapshots.revisions(id);
        const latest = revisions.at(-1) ?? 0;
        if (revision > latest + 1)
          throw new Error("Nonconsecutive artifact publication");
        return snapshots.writeIfAbsent(id, revision, record);
      }),
  };
  constructor(
    readonly file: string,
    private readonly failpoint?: (
      phase: "before-rename" | "after-rename",
    ) => void,
  ) {}
  private async load(): Promise<WorkspaceData> {
    try {
      const data = JSON.parse(
        await readFile(this.file, "utf8"),
      ) as WorkspaceData;
      if (data.version !== 1 || !data.snapshots || !data.registry)
        throw new Error("Invalid workspace state");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial();
      throw error;
    }
  }
  async read(): Promise<RegistryState> {
    return jsonCopy((await this.load()).registry);
  }
  async transact<T>(
    change: (registry: RegistryState) => Promise<T>,
  ): Promise<T> {
    return this.transactWorkspace(async (registry) => change(registry));
  }
  async transactWorkspace<T>(
    change: (registry: RegistryState, snapshots: SnapshotStorage) => Promise<T>,
  ): Promise<T> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true });
    const lock = `${this.file}.lock`;
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Workspace writer lock held");
      throw error;
    }
    let temp: string | undefined;
    let transactionSnapshots: SnapshotStorage | undefined;
    try {
      const data = await this.load();
      const before = canonicalJson(data);
      transactionSnapshots = view(data);
      activeTransactionViews.set(transactionSnapshots, this.snapshots);
      const result = await change(data.registry, transactionSnapshots);
      if (canonicalJson(data) !== before) {
        temp = path.join(directory, `.${randomUUID()}.pending`);
        const file = await open(temp, "wx", 0o600);
        try {
          await file.writeFile(canonicalJson(data), "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        this.failpoint?.("before-rename");
        await rename(temp, this.file);
        temp = undefined;
        const parent = await open(directory, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
        this.failpoint?.("after-rename");
      }
      return result === undefined ? result : jsonCopy(result);
    } finally {
      if (transactionSnapshots)
        activeTransactionViews.delete(transactionSnapshots);
      if (temp) await rm(temp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
