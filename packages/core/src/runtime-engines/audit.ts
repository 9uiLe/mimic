import { jsonCopy } from "../artifact-canonical.js";
import { RuntimeEngineError, type ExactArtifactRef } from "./dependency.js";

export interface AuditEventInput {
  readonly runId: string;
  readonly actor: {
    readonly kind: "human" | "agent" | "skill" | "import";
    readonly id: string;
  };
  readonly at: string;
  readonly action: string;
  readonly outcome: "allowed" | "blocked" | "observed";
  readonly reason: string;
  readonly inputs: readonly ExactArtifactRef[];
  readonly outputs: readonly ExactArtifactRef[];
}
export interface AuditEvent extends AuditEventInput {
  readonly sequence: number;
}
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

/** Append-only ordered events; an injected sink makes them durable outside this process. */
export class ExecutionAuditLog {
  private readonly records: AuditEvent[] = [];
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly sink?: AuditSink) {}

  async record(input: AuditEventInput): Promise<AuditEvent> {
    if (
      !input ||
      !input.runId?.trim() ||
      !input.actor?.id?.trim() ||
      !["human", "agent", "skill", "import"].includes(input.actor.kind) ||
      !Number.isFinite(Date.parse(input.at)) ||
      !input.action?.trim() ||
      !["allowed", "blocked", "observed"].includes(input.outcome) ||
      !input.reason?.trim() ||
      !Array.isArray(input.inputs) ||
      !Array.isArray(input.outputs)
    )
      throw new RuntimeEngineError("INVALID", "Invalid audit event");
    const copy = jsonCopy(input);
    for (const ref of [...copy.inputs, ...copy.outputs]) {
      if (
        !ref ||
        !/^art_[A-Za-z0-9_-]+$/.test(ref.artifactId) ||
        !Number.isSafeInteger(ref.revision) ||
        ref.revision < 1 ||
        !/^sha256:[0-9a-f]{64}$/.test(ref.lockDigest)
      )
        throw new RuntimeEngineError(
          "INVALID",
          "Invalid audit artifact reference",
        );
    }
    const operation = this.pending.then(async () => {
      const event = { ...copy, sequence: this.records.length + 1 };
      if (this.sink) await this.sink.append(jsonCopy(event));
      this.records.push(event);
      return jsonCopy(event);
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  events(): readonly AuditEvent[] {
    return jsonCopy(this.records);
  }
}
