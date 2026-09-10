import type { SpanAdapter, AdapterMatch } from "./types";
import { looksLikeJson } from "./helpers";

/** Handles instrumentation that stores a non-JSON prompt in `ai.prompt`. */
export const rawPromptLlmAdapter: SpanAdapter = {
  name: "raw-prompt-llm",
  apply(input): AdapterMatch | null {
    if (input.spanType !== "LLM_GENERATION") return null;
    const prompt = input.attrs["ai.prompt"] as string | undefined;
    if (typeof prompt !== "string" || !prompt) return null;
    // Structured prompts belong to the AI SDK adapter.
    if (looksLikeJson(prompt)) {
      try { JSON.parse(prompt); return null; } catch { /* not JSON — claim it */ }
    }

    const model = (input.attrs["ai.response.model"] as string | undefined)
      ?? (input.attrs["ai.model.id"] as string | undefined);

    const systemPromptRaw = input.attrs["ai.prompt.system"];
    const systemPrompt = typeof systemPromptRaw === "string" ? systemPromptRaw : "";

    const outputPayload = (input.attrs["ai.response.text"] as string | undefined)
      ?? (input.attrs["ai.response.object"] as string | undefined);

    return {
      inputPayload: prompt,
      outputPayload,
      normalized: {
        kind: "llm",
        messages: [{ role: "user", content: prompt }],
        userMessage: prompt,
        systemPrompt,
        model,
      },
    };
  },
};
