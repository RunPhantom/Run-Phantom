/**
 * Canonical, SDK-agnostic view of a parsed span.
 *
 * Run Phantom ingests OTLP traces from multiple SDKs (AI SDK, Claude Agent
 * SDK, Traceloop, and others). Each emits the same conceptual
 * data — "user said X", "model called tool Y with args Z" — under different
 * attribute names and encodings. Without a normalization layer every
 * downstream consumer has to JSON.parse-and-guess; with one, every consumer
 * reads typed fields.
 *
 * The shape here is deliberately small. Add fields when a real consumer
 * needs them, not speculatively.
 */

/**
 * One message in the conversation as the agent saw it.
 *
 * `content` is always a string — content blocks (image / tool_use / etc.) are
 * flattened to their text representation. Adapters that drop non-text content
 * still record the original under `raw` so renderers that want full fidelity
 * can recover it.
 */
export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For role: "tool" — links the result back to the assistant's tool_use. */
  toolCallId?: string;
  /** Original OTLP form. Available for renderers that need image/tool_use. */
  raw?: unknown;
}

/**
 * Normalized view of an LLM-generation span.
 *
 * Always-defined fields (`messages`, `userMessage`, `systemPrompt`) use empty
 * defaults rather than null/undefined so consumers can render them without
 * branching. If extraction completely failed (unknown SDK shape) the view
 * still has these defaults — the consumer just sees an empty conversation.
 */
export interface NormalizedLLMSpan {
  kind: "llm";
  /** Always an array. Empty if extraction failed or no messages were present. */
  messages: NormalizedMessage[];
  /**
   * The last user-role message text. Convenience for "what should we pre-fill
   * in the replay user-message box?" without re-walking `messages`.
   * Empty string if no user messages exist.
   */
  userMessage: string;
  /**
   * System prompt as a single string. Multiple system messages are joined with
   * blank lines. Empty string if no system prompt was sent.
   */
  systemPrompt: string;
  model?: string;
  providerOptions?: Record<string, unknown>;
}

/** Normalized view of a tool-call span. Args/result are pre-parsed (or raw if not JSON). */
export interface NormalizedToolSpan {
  kind: "tool";
  name: string;
  args: unknown;
  result: unknown;
  resultIsError: boolean;
}

/** Span we couldn't normalize (e.g. internal/instrumentation spans). */
export interface NormalizedOtherSpan {
  kind: "other";
}

export type NormalizedSpan = NormalizedLLMSpan | NormalizedToolSpan | NormalizedOtherSpan;

export function emptyNormalized(): NormalizedOtherSpan {
  return { kind: "other" };
}

