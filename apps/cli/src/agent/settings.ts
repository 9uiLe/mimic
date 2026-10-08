/** Selection IDs are candidates, not a claim that an adapter is installed. */
export type ProviderId = "codex" | "claude" | "gemini";
export interface SubscriptionSettings {
  provider: ProviderId;
  billingMode: "subscription-only";
  model?: string;
}

export function parseSubscriptionSettings(
  value: unknown,
): SubscriptionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor settings must be an object");
  const settings = value as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (!["provider", "billingMode", "model"].includes(key))
      throw new Error(`Unsupported executor setting: ${key}`);
  }
  if (!["codex", "claude", "gemini"].includes(String(settings.provider)))
    throw new Error("Unsupported provider");
  if (settings.billingMode !== "subscription-only")
    throw new Error("Only subscription-only billing is allowed");
  if (
    settings.model !== undefined &&
    (typeof settings.model !== "string" || !settings.model.trim())
  )
    throw new Error("Model must be a nonempty account-entitled model ID");
  return {
    provider: settings.provider as ProviderId,
    billingMode: "subscription-only",
    ...(settings.model === undefined
      ? {}
      : { model: settings.model as string }),
  };
}
