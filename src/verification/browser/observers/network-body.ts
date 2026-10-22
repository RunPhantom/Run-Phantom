/** Opt-in detached response copies. Never fetches a body on its own. */
import { BUSINESS_LIMITS as L, type BodyFormat, type BodyState } from "../../protocol.js";
import { sanitizeWithReport } from "../../serialization.js";
import type { Emit, Teardown } from "./types.js";

export interface BodyIdentity { requestId: string; actionId?: string }
export type BodyPrepare = (value: unknown) => { value: unknown; truncated: boolean };
function formatOf(mime: string): BodyFormat {
  const value = mime.split(";", 1)[0]?.trim().toLowerCase();
  return value === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(value ?? "") ? "json"
    : value === "text/event-stream" ? "sse" : value === "application/x-ndjson" ? "ndjson" : "none";
}
function decodeBody(raw: string, format: BodyFormat): unknown {
  if (format === "json") return JSON.parse(raw);
  if (format === "ndjson") return raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const records: unknown[] = [];
  // SSE comments, event names and ids are metadata; only complete JSON data records are retained.
  const blocks = raw.replace(/\r\n|\r/g, "\n").split("\n\n");
  const tail = blocks.pop() ?? "";
  // EOF does not dispatch an SSE record. Withhold partial data instead of claiming completion.
  if (tail.split("\n").some(line => line === "data" || line.startsWith("data:"))) throw new Error("Incomplete SSE record");
  for (const block of blocks) {
    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (data) records.push(JSON.parse(data));
  }
  return records;
}

export function createBodyObserver(emit: Emit, prepare: BodyPrepare): { fetch(response: Response, identity: BodyIdentity): void; xhr(xhr: XMLHttpRequest, identity: BodyIdentity): void; failed(identity: BodyIdentity): void; teardown: Teardown } {
  let active = true;
  const readers = new Map<ReadableStreamDefaultReader<Uint8Array>, () => void>();
  const encoder = new TextEncoder();
  const send = (identity: BodyIdentity, state: BodyState, format: BodyFormat, bytes = 0, chunks = 0, content?: unknown): void => {
    if (!active) return;
    const data: Record<string, unknown> = { requestId: identity.requestId, source: "sdk-reported", state, format, bytes, chunks };
    let incomplete = false;
    if (state === "complete") {
      const clean = sanitizeWithReport(content);
      const safe = prepare(clean.value);
      incomplete = Boolean(clean.truncation || safe.truncated && !clean.redacted);
      if (clean.truncation || encoder.encode(JSON.stringify(safe.value)).byteLength > L.BODY_BYTES) {
        data.state = "truncated";
      } else {
        data.body = safe.value;
        if (clean.redacted || safe.truncated) data.redacted = true;
      }
    }
    emit("network.body", data, identity.actionId ?? null, incomplete || data.redacted === true || data.state === "truncated");
  };
  const fetchBody = (response: Response, identity: BodyIdentity): void => {
    const format = formatOf(response.headers.get("content-type") ?? "");
    send(identity, "pending", format);
    if (response.type === "opaque" || response.type === "opaqueredirect") { send(identity, "opaque", format); return; }
    if (format === "none") { send(identity, "unsupported", format); return; }
    if (readers.size >= L.READERS) { send(identity, "unavailable", format); return; }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      const copy = response.clone();
      if (!copy.body) { send(identity, "unavailable", format); return; }
      reader = copy.body.getReader();
    } catch { send(identity, "unavailable", format); return; }
    let finished = false;
    let bytes = 0;
    let chunks = 0;
    let raw = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const finish = (state: BodyState, content?: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      readers.delete(reader);
      raw = "";
      send(identity, state, format, bytes, chunks, content);
      // Tee cancellation may wait on the app's branch: never await it or delay the original response.
      if (state !== "complete") void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* An outstanding read releases when cancellation settles. */ }
    };
    const timer = setTimeout(() => finish("timeout"), L.DEADLINE_MS);
    readers.set(reader, () => finish("aborted"));
    void (async () => {
      try {
        while (!finished && active) {
          const part = await reader.read();
          if (finished || !active) return;
          if (part.done) {
            raw += decoder.decode();
            let value: unknown;
            try { value = decodeBody(raw, format); } catch { finish("unavailable"); return; }
            finish("complete", value); return;
          }
          if (chunks >= L.CHUNKS || bytes + part.value.byteLength > L.RAW_BYTES) { finish("truncated"); return; }
          chunks++;
          bytes += part.value.byteLength;
          raw += decoder.decode(part.value, { stream: true });
        }
      } catch (error) { finish(error instanceof DOMException && error.name === "AbortError" ? "aborted" : "unavailable"); }
    })();
  };
  const xhrBody = (xhr: XMLHttpRequest, identity: BodyIdentity): void => {
    const format = formatOf(xhr.getResponseHeader("content-type") ?? "");
    send(identity, "pending", format);
    // Browsers already buffered XHR text. Only a bounded text response is inspected; binary and JSON modes stay opaque.
    if (xhr.status === 0) { send(identity, "aborted", format); return; }
    if (format === "none" || !["", "text"].includes(xhr.responseType)) { send(identity, "unsupported", format); return; }
    const raw = xhr.responseText;
    if (raw.length > L.RAW_BYTES) { send(identity, "truncated", format); return; }
    const bytes = encoder.encode(raw).byteLength;
    if (bytes > L.RAW_BYTES) { send(identity, "truncated", format); return; }
    try { send(identity, "complete", format, bytes, bytes ? 1 : 0, decodeBody(raw, format)); }
    catch { send(identity, "unavailable", format, bytes); }
  };
  return { fetch: fetchBody, xhr: xhrBody, failed(identity) { send(identity, "pending", "none"); send(identity, "aborted", "none"); }, teardown() {
    for (const cancel of readers.values()) cancel();
    readers.clear(); active = false;
  } };
}
