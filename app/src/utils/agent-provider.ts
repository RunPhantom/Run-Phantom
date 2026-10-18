export type AgentProviderId = "claude" | "codex" | "opencode";

export function isAgentProvider(value: unknown): value is AgentProviderId {
  return value === "claude" || value === "codex" || value === "opencode";
}

export function providerLabel(provider: AgentProviderId): string {
  return provider === "opencode" ? "OpenCode" : provider === "codex" ? "Codex" : "Claude Code";
}
