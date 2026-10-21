/**
 * Single entry point for turning raw OTLP attributes into a typed,
 * SDK-agnostic view consumers can read without parsing strings.
 *
 *   ┌──────────────────────────────┐
 *   │ parseOtlpRequest (live ingest)│ ─┐
 *   └──────────────────────────────┘  │   ┌──────────────────┐
 *                                     ├──▶│ normalizeSpan()  │──▶ AdapterMatch
 *   ┌──────────────────────────────┐  │   └──────────────────┘
 *   │ getRunWithSpans (DB rows)    │ ─┘
 *   └──────────────────────────────┘
 *
 * Adapters are tried in the order listed below. First match wins. A no-match
 * default returns `{ kind: "other" }` so consumers always have *something*.
 *
 * Order matters: more-specific adapters go before less-specific ones.
 *   - `aiSdkLlmAdapter` matches structured prompts (JSON `ai.prompt(.messages)`)
 *   - `rawPromptLlmAdapter` is the raw-string fallback
 *   - `traceloopLlmAdapter` looks for the traceloop discriminator
 *   - tool adapters key off `spanType === "TOOL_CALL"`
 *   - TRACE wrappers intentionally normalize to `{ kind: "other" }`
 *
 * Adding a new SDK = add one file under `adapters/` and one entry here.
 */
import type { AdapterInput, AdapterMatch, SpanAdapter } from "./adapters/types";
import { emptyNormalized } from "./normalized";
import { hasDuplicateJsonKeys } from "../json-keys";
import { aiSdkLlmAdapter, aiSdkToolAdapter } from "./adapters/ai-sdk";
import { rawPromptLlmAdapter } from "./adapters/raw-prompt";
import { livekitLlmAdapter, livekitToolAdapter } from "./adapters/livekit";
import { traceloopLlmAdapter, traceloopToolAdapter } from "./adapters/traceloop";
import { openInferenceLlmAdapter, openInferenceToolAdapter } from "./adapters/openinference";
import { genAiMetadataAdapter, genAiToolAdapter } from "./adapters/gen-ai";

import { captureKindAdapter, captureVisibility, readCaptureReceipt } from "./adapters/capture-visibility";

import { parseBoundedHookJson } from "../coding-hooks/shared";
import { cursorHookAdapter } from "./adapters/cursor-hook";
import { claudeHookAdapter } from "./adapters/claude-hook";
import { codexHookAdapter } from "./adapters/codex-hook";

const ADAPTERS: SpanAdapter[] = [
  cursorHookAdapter,
  claudeHookAdapter,
  codexHookAdapter,
  captureKindAdapter,
  aiSdkLlmAdapter,
  livekitLlmAdapter,
  traceloopLlmAdapter,
  rawPromptLlmAdapter,
  aiSdkToolAdapter,
  livekitToolAdapter,
  traceloopToolAdapter,
  openInferenceLlmAdapter,
  openInferenceToolAdapter,
  genAiToolAdapter,
  genAiMetadataAdapter,
];

export function normalizeSpan(input: AdapterInput): AdapterMatch {
  if (input.attributesUnavailable) return { normalized: emptyNormalized() };
  for (const a of ADAPTERS) {
    const result = a.apply(input);
    if (result) { const capture = captureVisibility(input); return { ...result, ...(capture ? { captureVisibility: capture } : {}) }; }
  }
  const capture = captureVisibility(input);
  return { normalized: emptyNormalized(), ...(capture ? { captureVisibility: capture } : {}) };
}

/**
 * Build an `AdapterInput` from a stored DB row. Used at read time when we
 * want the typed view but the original OTLP request is long gone.
 */
export function adapterInputFromStoredSpan(row: {
  name: string;
  id?: string; run_id?: string; otlp_evidence?: string | null;
  span_type: string | null;
  input_payload: string | null;
  output_payload: string | null;
  attributes: string | null;
}): AdapterInput {
  let attrs: Record<string, string | number | boolean> = {};
  if (row.attributes) {
    try {
      const parsed = JSON.parse(row.attributes);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) attrs = parsed;
      if (hasDuplicateJsonKeys(row.attributes)) return { spanName: row.name, spanType: "INTERNAL", attrs: {}, attributesUnavailable: true };
    } catch { /* leave empty */ }
    if (typeof attrs?.captureContract === "string" && (attrs.captureContract.startsWith("runphantom.claude-hook.observation/") || attrs.captureContract.startsWith("runphantom.cursor-hook.observation/")) && parseBoundedHookJson(row.attributes, 16384).status !== "accepted") {
      attrs = { captureContract: attrs.captureContract, invalidCapture: true };
    }
  }
  const spanType =
    row.span_type === "LLM_GENERATION" ||
    row.span_type === "TOOL_CALL" ||
    row.span_type === "AGENT_ROOT" ||
    row.span_type === "RETRIEVAL" || row.span_type === "EMBEDDING" ||
    row.span_type === "TRACE"
      ? row.span_type
      : "INTERNAL";
  return {
    spanName: row.name,
    traceId: row.run_id, spanId: row.id, otlpEvidence: readCaptureReceipt(row.otlp_evidence),
    attrs,
    spanType,
    inputPayload: row.input_payload ?? undefined,
    outputPayload: row.output_payload ?? undefined,
    operationId: attrs["ai.operationId"] as string | undefined,
    traceloopKind: attrs["traceloop.span.kind"] as string | undefined,
  };
}

/**
 * Convenience: re-normalize a stored span row, returning just the typed view.
 * Used by API endpoints that augment span responses for the UI / replay.
 */
export function normalizeStoredSpan(row: {
  name: string;
  id?: string; run_id?: string; otlp_evidence?: string | null;
  span_type: string | null;
  input_payload: string | null;
  output_payload: string | null;
  attributes: string | null;
}): AdapterMatch {
  return normalizeSpan(adapterInputFromStoredSpan(row));
}
