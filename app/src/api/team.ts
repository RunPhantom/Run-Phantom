import { boundedPromptJson } from "../components/prompts/client";
import type { ApiError, SessionResponse } from "../../../src/team/protocol";
export type * from "../../../src/team/protocol";

export class TeamApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message);
    this.name = "TeamApiError";
  }
}

async function boundedTeamReviewJson(response: Response): Promise<unknown> {
  const invalid = () => new TeamApiError(502, "invalid_response", "The project review response is unavailable or exceeds its bounds.");
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) throw invalid(); chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One in-memory client per team session provider; no local daemon requests. */
export class TeamClient {
  private csrf: string | null = null;
  private principal: string | null = null;
  private generation = 0;
  private projectGenerations = new Map<string, number>();
  constructor(private onAccessError: (status: number, path: string) => void) {}

  setSession(session: SessionResponse) {
    const principal = session.authenticated ? session.session.id : null;
    if (this.principal !== principal) { this.generation++; this.projectGenerations.clear(); }
    this.principal = principal;
    this.csrf = session.csrfToken;
  }

  async request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    return this.jsonRequest(path, options, false);
  }

  /** Prompt transport keeps the ordinary Team request budget unchanged. */
  async prompts<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; responseBytes?: 65536 | 131072 } = {}): Promise<T> {
    if (!/^\/projects\/[0-9a-f-]{36}\/prompts(?:\/|\?|$)/.test(path) || path.includes("#") || path.includes("\\")) throw new TeamApiError(400, "invalid_request", "Choose a project prompt endpoint.");
    if (options.body !== undefined && new TextEncoder().encode(JSON.stringify(options.body)).byteLength > 65536) throw new TeamApiError(413, "too_large", "Prompt request exceeds its limit.");
    return this.jsonRequest(path, options, true);
  }

  /** Project review transport preserves the ordinary Team request and prompt budgets. */
  async reviews<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    if (!/^\/projects\/[0-9a-f-]{36}\/review-(?:queues|datasets)(?:\/|\?|$)/.test(path) || path.includes("#") || path.includes("\\")) throw new TeamApiError(400, "invalid_request", "Choose a project review endpoint.");
    if (options.body !== undefined && new TextEncoder().encode(JSON.stringify(options.body)).byteLength > 65536) throw new TeamApiError(413, "too_large", "Project review request exceeds its limit.");
    return this.jsonRequest(path, options, "review");
  }

  private async jsonRequest<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; responseBytes?: 65536 | 131072 }, prompt: boolean | "review"): Promise<T> {
    const generation = this.generation;
    const project = path.match(/^\/projects\/([^/?]+)(?:\/|$)/)?.[1];
    const projectGeneration = project ? this.projectGenerations.get(project) ?? 0 : 0;
    const method = options.method ?? "GET";
    // A fresh membership read resolves permission changes. Its caller cancels
    // the previous read, while resource responses retain generation protection.
    const membershipRead = project && method === "GET" && path === `/projects/${project}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && this.csrf) headers["X-RunPhantom-CSRF"] = this.csrf;
    const response = await fetch(`/api/team${path}`, {
      method, headers, credentials: "same-origin", cache: "no-store", signal: options.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const data: unknown = response.status === 204 ? undefined : prompt === "review" ? await boundedTeamReviewJson(response) : prompt ? await boundedPromptJson(response, options.responseBytes) : await response.json().catch(() => undefined);
    if (generation !== this.generation || options.signal?.aborted || project && !membershipRead && projectGeneration !== (this.projectGenerations.get(project) ?? 0)) throw new DOMException("Request superseded", "AbortError");
    if (!response.ok) {
      const failure = (data as ApiError | undefined)?.error;
      // A response issued under the previous project permission state must not
      // reveal a one-time credential after a later request discovers revocation.
      if ((response.status === 403 || response.status === 404) && project) this.projectGenerations.set(project, projectGeneration + 1);
      if (response.status === 401 || response.status === 403 || response.status === 404) this.onAccessError(response.status, path);
      throw new TeamApiError(response.status, failure?.code ?? "request_failed", failure?.message ?? "The request could not be completed. Please try again.", failure?.requestId);
    }
    return data as T;
  }

  /** Dedicated external-report transport; the generic Team request budget stays unchanged. */
  async evidence<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const result = await this.evidenceBody(path, options, false);
    result.assertCurrent();
    if (result.bytes.byteLength === 0) return undefined as T;
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)) as T; }
    catch { throw new TeamApiError(502, "invalid_response", "The evidence response could not be read."); }
  }

  async evidenceBlob(path: string, signal?: AbortSignal): Promise<Blob> {
    const result = await this.evidenceBody(path, { signal }, true);
    result.assertCurrent();
    return new Blob([result.bytes], { type: result.contentType });
  }

  private async evidenceBody(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal }, blob: boolean): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string; assertCurrent: () => void }> {
    const project = path.match(/^\/projects\/([^/?]+)\/evidence(?:\/|\?|$)/)?.[1];
    const canonical = new URL(`/api/team${path}`, "http://team.invalid");
    if (!project || path.includes("#") || path.includes("\\") || canonical.pathname !== `/api/team${path.split("?")[0]}`) throw new TeamApiError(400, "invalid_request", "Choose a project evidence endpoint.");
    const generation = this.generation, projectGeneration = this.projectGenerations.get(project) ?? 0;
    const current = () => {
      if (generation !== this.generation || options.signal?.aborted || projectGeneration !== (this.projectGenerations.get(project) ?? 0)) throw new DOMException("Request superseded", "AbortError");
    };
    current();
    const method = options.method ?? "GET", headers: Record<string, string> = { Accept: blob ? "*/*" : "application/json" };
    let body: BodyInit | undefined;
    if (options.body instanceof Blob) {
      if (method !== "POST" || path !== `/projects/${project}/evidence/imports` || options.body.type !== "application/vnd.runphantom.evidence-import.v1+octet-stream") throw new TeamApiError(400, "invalid_request", "Choose a supported evidence upload.");
      if (options.body.size > 8 * 1024 * 1024 + 64 * 1024 + 4) throw new TeamApiError(413, "too_large", "The evidence upload exceeds its byte limit.");
      headers["Content-Type"] = options.body.type; body = options.body;
    } else if (options.body !== undefined) {
      const control = method === "PUT" && path === `/projects/${project}/evidence/inventories`
        || method === "POST" && (/^\/projects\/[^/?]+\/evidence\/sets\/[^/?]+\/reparse$/.test(path) || /^\/projects\/[^/?]+\/evidence\/imports\/[^/?]+\/cancel$/.test(path));
      if (!control) throw new TeamApiError(400, "invalid_request", "Choose a supported evidence control.");
      const json = JSON.stringify(options.body);
      if (new TextEncoder().encode(json).byteLength > 64 * 1024) throw new TeamApiError(413, "too_large", "The evidence control exceeds 64 KiB.");
      headers["Content-Type"] = "application/json"; body = json;
    }
    if (method !== "GET" && this.csrf) headers["X-RunPhantom-CSRF"] = this.csrf;
    const response = await fetch(`/api/team${path}`, { method, headers, credentials: "same-origin", cache: "no-store", signal: options.signal, ...(body === undefined ? {} : { body }) });
    const max = /\/sets\/[^/?]+\/raw\/[^/?]+(?:\?|$)/.test(path) ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
    const chunks: Uint8Array[] = []; let total = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      current();
      const encoding = response.headers.get("Content-Encoding");
      if (encoding && encoding.toLowerCase() !== "identity") throw new TeamApiError(502, "invalid_response", "Evidence responses require identity encoding.");
      const declared = response.headers.get("Content-Length");
      if (declared !== null && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new TeamApiError(502, "invalid_response", "The evidence response has an invalid byte length.");
      if (declared !== null && Number(declared) > max) throw new TeamApiError(413, "too_large", "The evidence response exceeds its byte limit.");
      reader = response.body?.getReader();
      if (reader) for (;;) {
        current(); const part = await reader.read(); current();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > max) throw new TeamApiError(413, "too_large", "The evidence response exceeds its byte limit.");
        chunks.push(part.value);
      }
      current();
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (!response.ok) {
        let data: ApiError | undefined;
        try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ApiError; } catch { /* Safe fallback for malformed error responses. */ }
        current();
        if (response.status === 403 || response.status === 404) this.projectGenerations.set(project, projectGeneration + 1);
        if (response.status === 401 || response.status === 403 || response.status === 404) this.onAccessError(response.status, path);
        const failure = data?.error;
        throw new TeamApiError(response.status, typeof failure?.code === "string" ? failure.code : "request_failed", typeof failure?.message === "string" ? failure.message : "The request could not be completed. Please try again.", typeof failure?.requestId === "string" ? failure.requestId : undefined);
      }
      current();
      return { bytes, contentType: response.headers.get("Content-Type") ?? "application/octet-stream", assertCurrent: current };
    } catch (error) {
      if (reader) await reader.cancel().catch(() => {});
      else await response.body?.cancel().catch(() => {});
      throw error;
    } finally { reader?.releaseLock(); }
  }
}

export function teamQuery(values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function projectApi(projectId: string): string { return `/projects/${encodeURIComponent(projectId)}`; }
export function projectPath(projectId: string): string { return `/team/projects/${encodeURIComponent(projectId)}`; }

export function downloadTeamJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
