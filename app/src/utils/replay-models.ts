const DEFAULT_REPLAY_MODEL_FALLBACKS = [
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export function buildReplayModelOptions(opts: {
  selectedModel?: string | null;
  runModel?: string | null;
  metadataModel?: string | null;
  anthropicModels?: string[];
  agentModels?: readonly unknown[];
}): string[] {
  // A registered replay agent that declares its models is the authority on
  // what it can run; provider catalogues and defaults are only a fallback.
  const declared = (opts.agentModels ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const merged = [
    opts.selectedModel ?? null,
    opts.runModel ?? null,
    opts.metadataModel ?? null,
    ...(declared.length ? declared : [...(opts.anthropicModels ?? []), ...DEFAULT_REPLAY_MODEL_FALLBACKS]),
  ];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const value of merged) {
    const next = value?.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    list.push(next);
  }
  return list;
}
