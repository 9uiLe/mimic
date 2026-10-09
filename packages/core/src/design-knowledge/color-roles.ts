/** Structural checks for provisional, same-content color strategy proposals. */
export interface ColorRoleContract {
  readonly requiredRoles: readonly string[];
  readonly requiredContexts: readonly string[];
  readonly requiredContextRoles: Readonly<Record<string, readonly string[]>>;
  readonly sourceCaseIds: readonly string[];
  readonly collisionReview: readonly {
    readonly roles: readonly [string, string];
    readonly question: string;
  }[];
}

export interface ColorRoleProposal {
  readonly intent: string;
  readonly sourceCaseIds: readonly string[];
  readonly roles: Readonly<Record<string, string>>;
  readonly contexts: Readonly<Record<string, readonly string[]>>;
  readonly sharedValueReasons?: readonly {
    readonly roles: readonly [string, string];
    readonly reason: string;
  }[];
}

/** Reports only verifiable omissions and ambiguous role reuse; visual quality needs review on actual screens. */
const normalizedValue = (value: string): string => {
  const trimmed = value.trim().toLowerCase();
  const shortHex = /^#([0-9a-f]{3}|[0-9a-f]{4})$/.exec(trimmed)?.[1];
  return shortHex
    ? `#${[...shortHex].map((character) => character.repeat(2)).join("")}`
    : trimmed;
};

export function checkColorRoleProposal(
  contract: ColorRoleContract,
  proposal: ColorRoleProposal,
): string[] {
  const issues: string[] = [];
  const required = new Set(contract.requiredRoles);
  if (!proposal.intent.trim()) issues.push("missing-intent");
  if (proposal.sourceCaseIds.length === 0) issues.push("missing-source-case");
  for (const id of proposal.sourceCaseIds)
    if (!contract.sourceCaseIds.includes(id))
      issues.push(`unknown-source-case:${id}`);
  for (const role of required)
    if (!proposal.roles[role]?.trim()) issues.push(`unmapped-role:${role}`);
  for (const role of Object.keys(proposal.roles))
    if (!required.has(role)) issues.push(`undeclared-role:${role}`);
  for (const context of contract.requiredContexts) {
    const used = proposal.contexts[context];
    if (!used?.length) {
      issues.push(`missing-context:${context}`);
      continue;
    }
    for (const role of used)
      if (!required.has(role) || !proposal.roles[role]?.trim())
        issues.push(`invalid-context-role:${context}:${role}`);
    for (const role of contract.requiredContextRoles[context] ?? [])
      if (!used.includes(role))
        issues.push(`missing-context-role:${context}:${role}`);
  }
  for (const context of Object.keys(proposal.contexts))
    if (!contract.requiredContexts.includes(context))
      issues.push(`undeclared-context:${context}`);
  const mapped = contract.requiredRoles.filter((role) =>
    proposal.roles[role]?.trim(),
  );
  for (let i = 0; i < mapped.length; i++) {
    for (let j = i + 1; j < mapped.length; j++) {
      const left = mapped[i]!;
      const right = mapped[j]!;
      if (
        normalizedValue(proposal.roles[left]!) !==
        normalizedValue(proposal.roles[right]!)
      )
        continue;
      const explained = proposal.sharedValueReasons?.some(
        (entry) =>
          entry.reason.trim() &&
          entry.roles.includes(left) &&
          entry.roles.includes(right),
      );
      if (!explained) issues.push(`unexplained-shared-value:${left}:${right}`);
    }
  }
  return issues;
}
