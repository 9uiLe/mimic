export interface Status {
  readonly name: string;
  readonly state: "ready";
}

export function getStatus(): Status {
  return { name: "mimic", state: "ready" };
}
