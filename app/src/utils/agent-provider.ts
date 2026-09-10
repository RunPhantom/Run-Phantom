export type AgentProviderId = "claude" | "codex";

export function isAgentProvider(value: unknown): value is AgentProviderId {
  return value === "claude" || value === "codex";
}

export function providerLabel(provider: AgentProviderId): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}
