/** Structural checks for provisional, same-content color strategy proposals. */
export interface ColorRoleContract {
  readonly requiredRoles: readonly string[];
  readonly requiredContexts: readonly string[];
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
  }
  for (const context of Object.keys(proposal.contexts))
    if (!contract.requiredContexts.includes(context))
      issues.push(`undeclared-context:${context}`);
  for (const {
    roles: [left, right],
  } of contract.collisionReview) {
    const value = proposal.roles[left]?.trim();
    if (!value || value !== proposal.roles[right]?.trim()) continue;
    const explained = proposal.sharedValueReasons?.some(
      (entry) =>
        entry.reason.trim() &&
        entry.roles.includes(left) &&
        entry.roles.includes(right),
    );
    if (!explained) issues.push(`unexplained-shared-value:${left}:${right}`);
  }
  return issues;
}
