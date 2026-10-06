/** Local, immutable design-knowledge input. It is not a canonical artifact or a seed library. */
export type NodeKind =
  | "trait"
  | "principle"
  | "space"
  | "case"
  | "mechanism"
  | "pattern"
  | "failure";
export interface KnowledgeNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly maturity: "provisional" | "reviewed";
  readonly evidenceRefs: readonly string[];
  readonly doNotBorrow?: readonly string[];
  readonly risks?: readonly string[];
}
export interface KnowledgeEdge {
  readonly from: string;
  readonly to: string;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}
export interface DesignKnowledgeGraph {
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly KnowledgeEdge[];
}
export type Fit = "low" | "medium" | "high";
export type Role = "near" | "adjacent" | "far" | "wildcard" | "anti-reference";
export interface CaseAssessment {
  readonly caseId: string;
  readonly role: Role;
  readonly structuralFit: Fit;
  readonly contextDistance: Fit;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  readonly unconventional?: boolean;
}
export interface CaseHistory {
  readonly caseId: string;
  readonly usageCount: number;
  readonly rejected: boolean;
  readonly reason?: string;
}
export interface RetrievalRequest {
  readonly traitIds: readonly string[];
  readonly assessments: readonly CaseAssessment[];
  readonly history?: readonly CaseHistory[];
  readonly limit?: number;
}
export interface Candidate {
  readonly caseId: string;
  readonly role: Role;
  readonly structuralFit: Fit;
  readonly contextDistance: Fit;
  readonly principleIds: readonly string[];
  readonly spaceIds: readonly string[];
  readonly mechanismIds: readonly string[];
  readonly patternIds: readonly string[];
  readonly failureIds: readonly string[];
  readonly doNotBorrow: readonly string[];
  readonly risks: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly rationale: string;
  readonly maturity: "provisional" | "reviewed";
  readonly usageCount: number;
}
export interface Exclusion {
  readonly caseId: string;
  readonly evidenceRefs: readonly string[];
  readonly doNotBorrow: readonly string[];
  readonly risks: readonly string[];
  readonly detail: string;
  readonly reason:
    | "duplicate-assessment"
    | "unknown-case"
    | "previously-rejected"
    | "no-trait-principle-space-mechanism-path"
    | "role-fit-mismatch";
}
export type RetrievalResult =
  | {
      readonly status: "blocked";
      readonly reason: "no-defensible-candidate";
      readonly selected: readonly [];
      readonly exclusions: readonly Exclusion[];
      readonly gaps: readonly string[];
    }
  | {
      readonly status: "ready";
      readonly selected: readonly Candidate[];
      readonly exclusions: readonly Exclusion[];
      readonly gaps: readonly string[];
    };

const links: Readonly<Record<NodeKind, readonly NodeKind[]>> = {
  trait: ["principle"],
  principle: ["space", "pattern", "failure"],
  space: ["case"],
  case: ["mechanism"],
  mechanism: ["principle"],
  pattern: [],
  failure: [],
};
const fitRank: Readonly<Record<Fit, number>> = { low: 0, medium: 1, high: 2 };
const sorted = (items: Iterable<string>) => [...new Set(items)].sort();
function nonempty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`Empty ${label}`);
}
/** Reject malformed links before retrieval, so missing knowledge cannot silently become a score. */
export function validateDesignKnowledgeGraph(
  graph: DesignKnowledgeGraph,
): void {
  const nodes = new Map<string, KnowledgeNode>();
  for (const node of graph.nodes) {
    nonempty(node.id, "node ID");
    nonempty(node.label, `node label ${node.id}`);
    if (nodes.has(node.id)) throw new Error(`Duplicate node: ${node.id}`);
    if (
      !node.evidenceRefs.length ||
      node.evidenceRefs.some((ref) => !ref.trim())
    )
      throw new Error(`Missing node evidence: ${node.id}`);
    nodes.set(node.id, node);
  }
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    if (!from || !to)
      throw new Error(`Dangling edge: ${edge.from} -> ${edge.to}`);
    if (!links[from.kind].includes(to.kind))
      throw new Error(`Invalid edge: ${from.kind} -> ${to.kind}`);
    nonempty(edge.rationale, `edge rationale ${edge.from} -> ${edge.to}`);
    if (
      !edge.evidenceRefs.length ||
      edge.evidenceRefs.some((ref) => !ref.trim())
    )
      throw new Error(`Missing edge evidence: ${edge.from} -> ${edge.to}`);
    const key = `${edge.from}\0${edge.to}`;
    if (edges.has(key))
      throw new Error(`Duplicate edge: ${edge.from} -> ${edge.to}`);
    edges.add(key);
  }
}
function roleFits(a: CaseAssessment): boolean {
  switch (a.role) {
    case "near":
      return a.structuralFit === "high" && a.contextDistance === "low";
    case "adjacent":
      return fitRank[a.structuralFit] >= 1 && a.contextDistance === "medium";
    case "far":
      return a.structuralFit === "high" && a.contextDistance === "high";
    case "wildcard":
      return a.unconventional === true && fitRank[a.structuralFit] >= 1;
    case "anti-reference":
      return a.structuralFit === "low";
  }
}
/** Resolve profile wording to explicit graph traits; unknown traits remain a reported knowledge gap. */
export function profileTraitIds(
  graph: DesignKnowledgeGraph,
  traits: readonly string[],
): string[] {
  validateDesignKnowledgeGraph(graph);
  if (!traits.length) throw new Error("Profile has no traits");
  const byLabel = new Map<string, string>();
  for (const node of graph.nodes.filter((item) => item.kind === "trait")) {
    if (byLabel.has(node.label))
      throw new Error(`Ambiguous graph trait: ${node.label}`);
    byLabel.set(node.label, node.id);
  }
  return traits.map((trait) => {
    const id = byLabel.get(trait);
    if (!id) throw new Error(`Unmapped profile trait: ${trait}`);
    return id;
  });
}

/** Traverse trait → principle → space → case → mechanism → principle. No case → UI edge exists. */
export function retrieveDesignReferences(
  graph: DesignKnowledgeGraph,
  request: RetrievalRequest,
): RetrievalResult {
  validateDesignKnowledgeGraph(graph);
  if (
    request.limit !== undefined &&
    (!Number.isSafeInteger(request.limit) || request.limit < 1)
  )
    throw new Error("Invalid retrieval limit");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, KnowledgeEdge[]>();
  for (const edge of graph.edges)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  const next = (id: string, kind: NodeKind) =>
    (outgoing.get(id) ?? []).filter(
      (edge) => nodes.get(edge.to)?.kind === kind,
    );
  for (const id of request.traitIds)
    if (nodes.get(id)?.kind !== "trait")
      throw new Error(`Unknown profile trait: ${id}`);
  const history = new Map<string, CaseHistory>();
  for (const entry of request.history ?? []) {
    if (history.has(entry.caseId))
      throw new Error(`Duplicate history: ${entry.caseId}`);
    if (entry.usageCount < 0 || !Number.isSafeInteger(entry.usageCount))
      throw new Error(`Invalid usage count: ${entry.caseId}`);
    history.set(entry.caseId, entry);
  }
  const exclusions: Exclusion[] = [],
    eligible: Candidate[] = [],
    seen = new Set<string>();
  const relevantPrinciples = new Set(
    request.traitIds.flatMap((id) =>
      next(id, "principle").map((edge) => edge.to),
    ),
  );
  for (const a of [...request.assessments].sort((x, y) =>
    x.caseId.localeCompare(y.caseId),
  )) {
    const caseNode = nodes.get(a.caseId);
    const exclude = (reason: Exclusion["reason"]) =>
      exclusions.push({
        caseId: a.caseId,
        reason,
        evidenceRefs: sorted([
          ...a.evidenceRefs,
          ...(caseNode?.evidenceRefs ?? []),
        ]),
        doNotBorrow: sorted(caseNode?.doNotBorrow ?? []),
        risks: sorted(caseNode?.risks ?? []),
        detail: history.get(a.caseId)?.reason ?? a.rationale,
      });
    if (seen.has(a.caseId)) {
      exclude("duplicate-assessment");
      continue;
    }
    seen.add(a.caseId);
    if (caseNode?.kind !== "case") {
      exclude("unknown-case");
      continue;
    }
    if (history.get(a.caseId)?.rejected) {
      exclude("previously-rejected");
      continue;
    }
    if (!roleFits(a)) {
      exclude("role-fit-mismatch");
      continue;
    }
    nonempty(a.rationale, `assessment rationale ${a.caseId}`);
    if (!a.evidenceRefs.length)
      throw new Error(`Missing assessment evidence: ${a.caseId}`);
    const paths: {
      principle: string;
      space: string;
      mechanism: string;
      evidence: string[];
    }[] = [];
    for (const traitId of request.traitIds)
      for (const tp of next(traitId, "principle"))
        for (const ps of next(tp.to, "space"))
          for (const sc of next(ps.to, "case")) {
            if (sc.to !== a.caseId) continue;
            for (const cm of next(a.caseId, "mechanism"))
              for (const mp of next(cm.to, "principle")) {
                if (mp.to !== tp.to) continue;
                paths.push({
                  principle: tp.to,
                  space: ps.to,
                  mechanism: cm.to,
                  evidence: [traitId, tp.to, ps.to, a.caseId, cm.to]
                    .flatMap((id) => nodes.get(id)!.evidenceRefs)
                    .concat(
                      tp.evidenceRefs,
                      ps.evidenceRefs,
                      sc.evidenceRefs,
                      cm.evidenceRefs,
                      mp.evidenceRefs,
                    ),
                });
              }
          }
    if (!paths.length) {
      exclude("no-trait-principle-space-mechanism-path");
      continue;
    }
    const principles = sorted(paths.map((p) => p.principle));
    const related = (kind: NodeKind) =>
      sorted(principles.flatMap((id) => next(id, kind).map((edge) => edge.to)));
    const associated = [
      caseNode,
      ...paths.map((p) => nodes.get(p.mechanism)!),
      ...related("pattern").map((id) => nodes.get(id)!),
      ...related("failure").map((id) => nodes.get(id)!),
    ];
    eligible.push({
      caseId: a.caseId,
      role: a.role,
      structuralFit: a.structuralFit,
      contextDistance: a.contextDistance,
      principleIds: principles,
      spaceIds: sorted(paths.map((p) => p.space)),
      mechanismIds: sorted(paths.map((p) => p.mechanism)),
      patternIds: related("pattern"),
      failureIds: related("failure"),
      doNotBorrow: sorted(associated.flatMap((node) => node.doNotBorrow ?? [])),
      risks: sorted(associated.flatMap((node) => node.risks ?? [])),
      evidenceRefs: sorted([
        ...a.evidenceRefs,
        ...paths.flatMap((p) => p.evidence),
        ...associated.flatMap((node) => node.evidenceRefs),
      ]),
      rationale: a.rationale,
      maturity: caseNode.maturity,
      usageCount: history.get(a.caseId)?.usageCount ?? 0,
    });
  }
  const selected: Candidate[] = [],
    coveredPrinciples = new Set<string>(),
    coveredMechanisms = new Set<string>();
  const remaining = [...eligible];
  const maxSelections = request.limit ?? remaining.length;
  while (remaining.length && selected.length < maxSelections) {
    remaining.sort((a, b) => {
      const gain = (c: Candidate) =>
        c.principleIds.filter((id) => !coveredPrinciples.has(id)).length * 2 +
        c.mechanismIds.filter((id) => !coveredMechanisms.has(id)).length;
      return (
        gain(b) - gain(a) ||
        fitRank[b.structuralFit] - fitRank[a.structuralFit] ||
        Number(b.maturity === "reviewed") - Number(a.maturity === "reviewed") ||
        a.usageCount - b.usageCount ||
        a.caseId.localeCompare(b.caseId)
      );
    });
    const candidate = remaining.shift()!;
    selected.push(candidate);
    candidate.principleIds.forEach((id) => coveredPrinciples.add(id));
    candidate.mechanismIds.forEach((id) => coveredMechanisms.add(id));
  }
  const gaps = [
    ...sorted(
      [...relevantPrinciples].filter((id) => !coveredPrinciples.has(id)),
    ).map((id) => `uncovered-principle:${id}`),
    ...(["near", "adjacent", "far", "wildcard", "anti-reference"] as Role[])
      .filter((role) => !selected.some((candidate) => candidate.role === role))
      .map((role) => `missing-role:${role}`),
  ];
  return selected.length
    ? { status: "ready", selected, exclusions, gaps }
    : {
        status: "blocked",
        reason: "no-defensible-candidate",
        selected: [],
        exclusions,
        gaps,
      };
}

/** Project a successful retrieval into the existing reference-selection content/provenance shape. */
export function referenceSelectionFromRetrieval(result: RetrievalResult): {
  readonly content: {
    readonly summary: string;
    readonly references: {
      readonly reference: string;
      readonly classification: Role;
      readonly structuralRelevance: Fit;
      readonly contextDistance: Fit;
      readonly transferableMechanisms: string[];
    }[];
  };
  readonly provenance: readonly {
    readonly path: string;
    readonly kind: "derived" | "hypothesis";
    readonly evidenceRefs?: string[];
    readonly rationale: string;
  }[];
} {
  if (result.status === "blocked")
    throw new Error("Blocked retrieval has no reference-selection output");
  const references = result.selected.map((candidate) => ({
    reference: candidate.caseId,
    classification: candidate.role,
    structuralRelevance: candidate.structuralFit,
    contextDistance: candidate.contextDistance,
    transferableMechanisms: [...candidate.mechanismIds],
  }));
  return {
    content: {
      summary: `Graph retrieval: ${references.length} defensible reference(s); ${result.gaps.length} gap(s).`,
      references,
    },
    provenance: [
      ...result.selected.map((candidate, index) => ({
        path: `/content/references/${index}`,
        kind: "hypothesis" as const,
        evidenceRefs: [...candidate.evidenceRefs],
        rationale: `Path: principles ${candidate.principleIds.join(", ")}; spaces ${candidate.spaceIds.join(", ")}; mechanisms ${candidate.mechanismIds.join(", ")}. ${candidate.rationale} Maturity: ${candidate.maturity}; prior uses: ${candidate.usageCount}. Do not borrow: ${candidate.doNotBorrow.join("; ") || "none identified"}. Risks: ${candidate.risks.join("; ") || "none identified"}. Failure modes: ${candidate.failureIds.join(", ") || "none linked"}. Conditional patterns: ${candidate.patternIds.join(", ") || "none linked"}. Transfer remains unverified.`,
      })),
      {
        path: "/content/summary",
        kind: "hypothesis" as const,
        evidenceRefs: sorted([
          ...result.selected.flatMap((candidate) => candidate.evidenceRefs),
          ...result.exclusions.flatMap((item) => item.evidenceRefs),
        ]),
        rationale: `Gaps: ${result.gaps.join("; ") || "none"}. Exclusions: ${result.exclusions.map((item) => `${item.caseId}:${item.reason} (${item.detail}); do not borrow: ${item.doNotBorrow.join(", ") || "none identified"}; risks: ${item.risks.join(", ") || "none identified"}`).join("; ") || "none"}.`,
      },
    ],
  };
}
