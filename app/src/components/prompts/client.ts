import type { PromptRevision, PromptSummary, PromptHistoryEntry, PromptPage, PromptCompilation, PromptExport } from "../../../../src/prompts/protocol";
export type { PromptRevision, PromptSummary, PromptHistoryEntry, PromptPage, PromptCompilation, PromptExport };
export interface PromptCapabilities { enabled: true; generation: number; policy: "literal-v1"; scope: "local" | "project" }
export interface PromptClient { request<T>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal; responseBytes?: 65536 | 131072 }): Promise<T> }
export class PromptClientError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export async function boundedPromptJson(response: Response, maximum: 65536 | 131072 = 131072): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new PromptClientError(502, "The prompt response could not be read.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new PromptClientError(413, "The prompt response exceeds its limit.");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new PromptClientError(502, "The prompt response could not be read."); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export const localPromptClient: PromptClient = { async request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; responseBytes?: 65536 | 131072 } = {}): Promise<T> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body && new TextEncoder().encode(body).byteLength > 65536) throw new PromptClientError(413, "Prompt request exceeds its limit.");
  const response = await fetch(`/api/prompts${path}`, { method: options.method ?? "GET", credentials: "same-origin", cache: "no-store", signal: options.signal, headers: body ? { "Content-Type": "application/json" } : {}, body });
  const value = await boundedPromptJson(response, options.responseBytes);
  options.signal?.throwIfAborted();
  if (!response.ok) throw new PromptClientError(response.status, response.status === 404 ? "Prompt registry is unavailable or the selected revision does not exist." : typeof value === "object" && value && "error" in value && typeof value.error === "string" ? value.error : "Prompt request failed.");
  return value as T;
} };
