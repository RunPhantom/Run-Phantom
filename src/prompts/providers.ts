import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { COMPARISON_LIMITS, comparisonJson, comparisonTarget, type ComparisonOptions, type ComparisonProvider, type ComparisonTarget } from "./comparison-protocol";
import { promptInteger, promptText } from "./protocol";
import type { ComparisonUsage } from "./spend-ledger";

export type ComparisonProvenance = "official-provider" | "controlled-http-fixture";
export type ProviderFailure = "unavailable" | "cancelled" | "timeout" | "provider_error" | "invalid_response" | "response_limit" | "protected_content";
const messages: Record<ProviderFailure, string> = { unavailable: "Provider credentials are unavailable.", cancelled: "Provider request was cancelled.", timeout: "Provider request timed out.", provider_error: "Provider request failed.", invalid_response: "Provider response was invalid.", response_limit: "Provider response exceeded its limit.", protected_content: "Provider response contains protected credentials." };
export class ComparisonProviderError extends Error {
  constructor(readonly code: ProviderFailure, readonly requestMayHaveBeenSent: boolean) { super(messages[code]); this.name = "ComparisonProviderError"; }
}
export interface ComparisonProviderResult { output: string; usage: ComparisonUsage; finishReason: string; provenance: ComparisonProvenance }
type Transport = (url: string | URL, init: RequestInit) => Promise<Response>;
interface ClientOptions { credentials?: Partial<Record<ComparisonProvider, string>>; transport?: Transport; provenance?: ComparisonProvenance }
const endpoints = Object.freeze({ openai: "https://api.openai.com/v1/chat/completions", anthropic: "https://api.anthropic.com/v1/messages" });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComparisonProviderError("invalid_response", true);
  return value as Record<string, unknown>;
};
async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ComparisonProviderError("invalid_response", true);
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new ComparisonProviderError("cancelled", true));
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > COMPARISON_LIMITS.providerResponseBytes) throw new ComparisonProviderError("response_limit", true);
      parts.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    try { return strictEvidenceJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), readerLimits({ maxDepth: 12 })); }
    catch { throw new ComparisonProviderError("invalid_response", true); }
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Constructor injection is private qualification plumbing; no request or runtime environment can select a URL. */
export function createComparisonProviderClient(client: ClientOptions = {}) {
  const transport = client.transport ?? ((url, init) => fetch(url, init)), provenance = client.provenance ?? "official-provider";
  return {
    available(provider: ComparisonProvider): boolean { const token = client.credentials?.[provider] ?? (client.credentials ? undefined : process.env[provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]); return typeof token === "string" && token.length > 0 && token.length <= 4096 && !/[\r\n\0]/.test(token); },
    async execute(input: { target: ComparisonTarget; compiled: string; options: ComparisonOptions; signal: AbortSignal; remainingMs?: number }): Promise<ComparisonProviderResult> {
      const target = comparisonTarget(input.target), compiled = promptText(input.compiled, COMPARISON_LIMITS.inputBytes), outputTokens = promptInteger(input.options.maxOutputTokens, COMPARISON_LIMITS.outputTokens);
      if (!Number.isFinite(input.options.temperature) || input.options.temperature < 0 || input.options.temperature > 1) throw new ComparisonProviderError("provider_error", false);
      if (!this.available(target.provider)) throw new ComparisonProviderError("unavailable", false);
      if (input.signal.aborted) throw new ComparisonProviderError("cancelled", false);
      const timeout = new AbortController(), remaining = input.remainingMs ?? COMPARISON_LIMITS.attemptMs;
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > COMPARISON_LIMITS.attemptMs) throw new ComparisonProviderError("timeout", false);
      const timer = setTimeout(() => timeout.abort(), remaining), signal = AbortSignal.any([input.signal, timeout.signal]);
      const token = client.credentials?.[target.provider] ?? process.env[target.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]!;
      const body = target.provider === "openai" ? { model: target.model, messages: [{ role: "user", content: compiled }], max_completion_tokens: outputTokens, temperature: input.options.temperature, stream: false }
        : { model: target.model, messages: [{ role: "user", content: compiled }], max_tokens: outputTokens, temperature: input.options.temperature, stream: false };
      const headers: Record<string, string> = target.provider === "openai" ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
        : { "Content-Type": "application/json", "x-api-key": token, "anthropic-version": "2023-06-01" };
      let sent = false;
      try {
        sent = true;
        const response = await transport(endpoints[target.provider], { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ComparisonProviderError("provider_error", true); }
        const raw = object(await responseJson(response, signal));
        let output: string, finishReason: string; const usage = raw.usage === undefined ? {} : object(raw.usage);
        if (target.provider === "openai") {
          if (!Array.isArray(raw.choices) || raw.choices.length !== 1) throw new ComparisonProviderError("invalid_response", true);
          const choice = object(raw.choices[0]), message = object(choice.message);
          if (typeof message.content !== "string" || !["stop", "length"].includes(String(choice.finish_reason)) || message.tool_calls !== undefined) throw new ComparisonProviderError("invalid_response", true);
          output = message.content; finishReason = String(choice.finish_reason);
        } else {
          if (!Array.isArray(raw.content) || raw.content.length > 16 || !["end_turn", "max_tokens", "stop_sequence"].includes(String(raw.stop_reason))) throw new ComparisonProviderError("invalid_response", true);
          output = raw.content.map(value => { const content = object(value); if (content.type !== "text" || typeof content.text !== "string") throw new ComparisonProviderError("invalid_response", true); return content.text; }).join(""); finishReason = String(raw.stop_reason);
        }
        try { output = promptText(output, COMPARISON_LIMITS.attemptPayloadBytes); }
        catch (error) { throw new ComparisonProviderError(error instanceof Error && "code" in error && error.code === "credentials" ? "protected_content" : "response_limit", true); }
        const cached = target.provider === "openai" && usage.prompt_tokens_details !== undefined ? object(usage.prompt_tokens_details).cached_tokens : usage.cache_read_input_tokens;
        const reasoning = target.provider === "openai" && usage.completion_tokens_details !== undefined ? object(usage.completion_tokens_details).reasoning_tokens : undefined;
        const result: ComparisonProviderResult = { output, finishReason, provenance, usage: { model: raw.model,
          inputTokens: target.provider === "openai" ? usage.prompt_tokens : usage.input_tokens, outputTokens: target.provider === "openai" ? usage.completion_tokens : usage.output_tokens,
          cacheReadTokens: cached, ...(target.provider === "anthropic" ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}), reasoningTokens: reasoning, tier: usage.service_tier ?? raw.service_tier ?? "standard" } };
        try { comparisonJson(result, COMPARISON_LIMITS.attemptPayloadBytes); } catch { throw new ComparisonProviderError("response_limit", true); }
        return result;
      } catch (error) {
        if (timeout.signal.aborted) throw new ComparisonProviderError("timeout", sent);
        if (input.signal.aborted) throw new ComparisonProviderError("cancelled", sent);
        if (error instanceof ComparisonProviderError) throw error;
        throw new ComparisonProviderError("provider_error", sent);
      } finally { clearTimeout(timer); }
    },
  };
}
