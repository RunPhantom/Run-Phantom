export interface ClaudeHookCaptureViewV1 {
  contract: "runphantom.claude-hook.observation/v1";
  entityKind: "session" | "prompt" | "tool" | "assistant" | "subagent";
  sourceKind: "hook" | "transcript";
  coverage: "partial";
  producerVerified: false;
  runtimeVerified: false;
  reportedPhase: "pending" | "success" | "failure" | "interrupted" | "complete" | "unknown" | "conflict";
  reportedDurationMs: number | null;
  usage: {
    freshInputTokens: number | null;
    outputTokens: number | null;
    cacheCreatedInputTokens: number | null;
    cacheReadInputTokens: number | null;
  } | null;
  userText: string | null;
  assistantText: string | null;
}

export interface ClaudeHookCaptureViewV2 extends Omit<ClaudeHookCaptureViewV1, "contract"> {
  contract: "runphantom.claude-hook.observation/v2";
  contextKey: string | null;
  contextRevision: number | null;
  sessionContextVersion: 2 | null;
  retainedSessionSha256: string | null;
}

export type ClaudeHookCaptureView = ClaudeHookCaptureViewV1 | ClaudeHookCaptureViewV2;

export interface CursorHookCaptureView extends Omit<ClaudeHookCaptureViewV1, "contract" | "sourceKind"> {
  contract: "runphantom.cursor-hook.observation/v1";
  sourceKind: "hook";
}

export interface CodexHookCaptureView extends Omit<ClaudeHookCaptureViewV1, "contract"> {
  contract: "runphantom.codex-hook.observation/v1";
}

export type HookCaptureView = ClaudeHookCaptureView | CursorHookCaptureView | CodexHookCaptureView;
