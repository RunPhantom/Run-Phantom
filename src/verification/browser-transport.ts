import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { BROWSER_HTTP_LIMITS as LIMIT } from "./browser-contract";
import type { BrowserEngine } from "./browser-types";

export const BROWSER_HTTP_REFUSALS = ["closed", "route-limit", "origin-policy", "foreign-profile-unavailable", "concurrency-limit", "body-total-limit", "method-unavailable", "request-headers", "cross-origin-method", "cross-origin-headers", "cross-origin-cookie-unavailable", "cookie-profile-unavailable", "authentication-unavailable", "request-body-limit", "deadline", "response-headers", "set-cookie-profile-unavailable", "redirect-unavailable", "compressed-response-unavailable", "download-unavailable", "response-length", "response-body-limit", "incomplete-response", "transport-unavailable", "cancelled", "fulfillment-unavailable"] as const;
export type BrowserHttpRefusal = typeof BROWSER_HTTP_REFUSALS[number];
export class BrowserTransportRefusal extends Error {
  constructor(readonly code: BrowserHttpRefusal) { super("Bounded browser transport unavailable"); }
}
const fail = (code: BrowserHttpRefusal): never => { throw new BrowserTransportRefusal(code); };
const reasonCode = (value: unknown): BrowserHttpRefusal => BROWSER_HTTP_REFUSALS.includes(value as BrowserHttpRefusal) ? value as BrowserHttpRefusal : "transport-unavailable";
export interface BrowserRawHeader { name: string; value: string }
export interface BrowserTransportRequest {
  url(): string; method(): string; isNavigationRequest(): boolean;
  headersArray(): Promise<BrowserRawHeader[]>; allHeaders(): Promise<Record<string, string>>; postDataBuffer(): Buffer | null;
}
export interface BrowserTransportRoute {
  request(): BrowserTransportRequest; abort(reason: "blockedbyclient"): Promise<void>;
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
}
export interface BrowserTransportAuthority {
  current(): boolean;
  // Only a worker-created initial navigation already issued under current
  // authority may wait for its exact native goto response/commit receipt.
  initial?: { pendingCommit(): boolean; acknowledge(): Promise<boolean>; finish(completed: boolean): void };
}
export interface BrowserTransportOptions {
  origin: string; assets: readonly string[]; controlOrigins: readonly string[];
  engine: BrowserEngine; ownership: "owned" | "attached";
  foreignQualified?: boolean;
  cookies(url: string): Promise<readonly unknown[]>;
  authority(request: BrowserTransportRequest): BrowserTransportAuthority;
  onRefusal(reason: BrowserHttpRefusal): void;
}
type Diagnostic = { result: "refused"; reason: BrowserHttpRefusal } | { result: "completed"; status: number; bytes: number };
interface Operation {
  until: number; chunks: Buffer[]; socket: ClientRequest | null; incoming: IncomingMessage | null;
  cancelled: BrowserHttpRefusal | null; timer?: ReturnType<typeof setTimeout>;
  authority: BrowserTransportAuthority; fulfillmentIssued: boolean; cancel(code: BrowserHttpRefusal): void;
}

export function browserRawHeaderBudget(raw: unknown, code: BrowserHttpRefusal): void {
  if (!Array.isArray(raw) || raw.length % 2 || raw.length / 2 > LIMIT.headerFields) fail(code);
  let bytes = 0;
  for (const value of raw as unknown[]) if (typeof value !== "string" || (bytes += Buffer.byteLength(value)) > LIMIT.headers) fail(code);
}
const SAFELIST_NAMES = new Set(["accept", "accept-language", "content-language", "content-type"]);
export function browserCorsUnsafeByte(byte: number): boolean {
  return byte < 0x20 && byte !== 0x09 || [0x22, 0x28, 0x29, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x7b, 0x7d, 0x7f].includes(byte);
}
export function browserSafelistedValue(name: string, value: unknown): boolean {
  // ASCII is the reviewed conservative subset; no driver encoding assumption.
  if (typeof value !== "string" || value.length > 128) return false;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0x7f) return false;
  if (name === "accept-language" || name === "content-language") return /^[0-9A-Za-z *,.=;-]*$/.test(value);
  if (name !== "accept" && name !== "content-type") return false;
  for (let i = 0; i < value.length; i++) if (browserCorsUnsafeByte(value.charCodeAt(i))) return false;
  if (name === "accept") return true;
  const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  const parts = value.split(";"), essence = parts.shift()!.replace(/^[\t ]+|[\t ]+$/g, "").toLowerCase();
  if (!["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"].includes(essence)) return false;
  const names = new Set<string>();
  for (const part of parts) {
    const parameter = part.replace(/^[\t ]+|[\t ]+$/g, ""), equal = parameter.indexOf("=");
    if (equal < 1 || !token.test(parameter.slice(0, equal)) || !token.test(parameter.slice(equal + 1))) return false;
    const name = parameter.slice(0, equal).toLowerCase();
    if (names.has(name)) return false;
    names.add(name);
  }
  return true;
}
export function browserForeignHeaderValues(raw: readonly BrowserRawHeader[], headers: Record<string, string>): void {
  let total = 0;
  for (const { name, value } of raw) if (SAFELIST_NAMES.has(name.toLowerCase())) {
    if (!browserSafelistedValue(name.toLowerCase(), value) || (total += value.length) > 1024) fail("cross-origin-headers");
  }
  for (const [name, value] of Object.entries(headers)) if (SAFELIST_NAMES.has(name) && !browserSafelistedValue(name, value)) fail("cross-origin-headers");
}
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const cookieValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
export function browserControlledCookies(cookies: readonly unknown[], actual: string | undefined, url: URL): void {
  if (!Array.isArray(cookies) || cookies.length > LIMIT.headerFields) fail("cookie-profile-unavailable");
  if (!cookies.length && actual === undefined) return;
  if (!actual || !cookies.length) fail("cookie-profile-unavailable");
  const known = new Map<string, string>();
  for (const value of cookies) {
    if (!value || typeof value !== "object") fail("cookie-profile-unavailable");
    const cookie = value as Record<string, unknown>;
    if (typeof cookie.name !== "string" || !cookieName.test(cookie.name) || typeof cookie.value !== "string" || !cookieValue.test(cookie.value)
      || cookie.httpOnly !== true || cookie.sameSite !== "Strict" || cookie.domain !== url.hostname || typeof cookie.path !== "string"
      || !cookie.path.startsWith("/") || !(url.pathname === cookie.path || url.pathname.startsWith(cookie.path) && (cookie.path.endsWith("/") || url.pathname[cookie.path.length] === "/"))
      || typeof cookie.secure !== "boolean" || cookie.secure && url.protocol !== "https:" || known.has(cookie.name)) fail("cookie-profile-unavailable");
    known.set(cookie.name as string, cookie.value as string);
  }
  const pairs = actual!.split("; ");
  if (pairs.length !== known.size) fail("cookie-profile-unavailable");
  for (const pair of pairs) {
    const equal = pair.indexOf("="), name = pair.slice(0, equal), value = pair.slice(equal + 1);
    if (equal < 1 || known.get(name) !== value) fail("cookie-profile-unavailable");
    known.delete(name);
  }
  if (known.size) fail("cookie-profile-unavailable");
}
export function browserControlledSetCookie(raw: readonly string[], url: URL): void {
  const fields: string[] = [];
  for (let index = 0; index < raw.length; index += 2) if (raw[index].toLowerCase() === "set-cookie") fields.push(raw[index + 1]);
  if (!fields.length) return;
  if (fields.length !== 1 || fields[0].includes(",")) fail("set-cookie-profile-unavailable");
  const parts = fields[0].split(";"), pair = parts.shift()!, equal = pair.indexOf("=");
  if (equal < 1 || !cookieName.test(pair.slice(0, equal)) || !cookieValue.test(pair.slice(equal + 1))) fail("set-cookie-profile-unavailable");
  const attributes = new Map<string, string>();
  for (const part of parts) {
    const attribute = part.trim(), equal = attribute.indexOf("="), name = (equal < 0 ? attribute : attribute.slice(0, equal)).toLowerCase(), value = equal < 0 ? "" : attribute.slice(equal + 1);
    if (attributes.has(name) || !["httponly", "samesite", "path", "secure"].includes(name)) fail("set-cookie-profile-unavailable");
    attributes.set(name, value);
  }
  if (!attributes.has("httponly") || attributes.get("httponly") !== "" || attributes.get("samesite")?.toLowerCase() !== "strict" || attributes.get("path") !== "/"
    || attributes.has("secure") && (attributes.get("secure") !== "" || url.protocol !== "https:")) fail("set-cookie-profile-unavailable");
}

/** Reviewed bounded-http-v1 core. Bounds cover adapter admission, not OS RAM. */
export function createBrowserTransport(options: BrowserTransportOptions) {
  let active = 0, maximum = 0, attempts = 0, beyondLimit = 0, total = 0, closed = false, closedCode: BrowserHttpRefusal = "closed", loss = false, completed = 0;
  const pending = new Set<ClientRequest>(), operations = new Set<Operation>(), records: Diagnostic[] = [];
  const counts = Object.fromEntries(BROWSER_HTTP_REFUSALS.map(code => [code, 0])) as Record<BrowserHttpRefusal, number>;
  const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const remember = (record: Diagnostic) => { records.push(record); if (records.length > 100) records.shift(); };
  const close = (code: BrowserHttpRefusal = "cancelled") => {
    closed = true; closedCode = reasonCode(code); loss = true;
    for (const operation of operations) operation.cancel(closedCode);
  };
  const fence = () => {
    for (const operation of operations) if (!operation.authority.current() && !(operation.fulfillmentIssued && operation.authority.initial?.pendingCommit())) operation.cancel("cancelled");
  };
  const allowed = (raw: string, navigation: boolean) => {
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !options.controlOrigins.includes(url.origin)
        && (url.origin === options.origin || !navigation && options.assets.includes(url.origin));
    } catch { return false; }
  };
  const handler = async (route: BrowserTransportRoute): Promise<void> => {
    // Charge every route before origin, capacity and native driver work.
    if (attempts < LIMIT.requests) attempts++; else beyondLimit = increment(beyondLimit);
    if (attempts >= LIMIT.requests) close("route-limit");
    const request = route.request(); let operation: Operation | undefined, acknowledged = false;
    const refuse = async (code: BrowserHttpRefusal) => {
      const reason = reasonCode(code); loss = true; counts[reason] = increment(counts[reason]); remember({ result: "refused", reason }); options.onRefusal(reason);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([route.abort("blockedbyclient"), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, operation ? operation.until - performance.now() : LIMIT.ms)); })]); }
      catch {} finally { clearTimeout(timer); }
    };
    try {
      if (closed) fail(closedCode);
      const authority = options.authority(request);
      if (!authority.current()) fail("cancelled");
      if (!allowed(request.url(), request.isNavigationRequest())) fail("origin-policy");
      if (active >= LIMIT.active) fail("concurrency-limit");
      if (total >= LIMIT.totalBody) { close("body-total-limit"); fail("body-total-limit"); }
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; }); void aborted.catch(() => {});
      const owned: Operation = { until: performance.now() + LIMIT.ms, chunks: [], socket: null, incoming: null, cancelled: null, authority, fulfillmentIssued: false,
        cancel(code) { if (this.cancelled) return; this.cancelled = code; this.chunks.length = 0; this.incoming?.destroy(); this.socket?.destroy(); rejectAbort(new BrowserTransportRefusal(code)); } };
      operation = owned; active++; maximum = Math.max(maximum, active); operations.add(owned);
      owned.timer = setTimeout(() => owned.cancel("deadline"), LIMIT.ms);
      const checkpoint = (bookkeeping = false) => {
        if (closed) fail(closedCode);
        if (owned.cancelled) fail(owned.cancelled);
        if (performance.now() >= owned.until) { owned.cancel("deadline"); fail("deadline"); }
        if (!authority.current() && !(bookkeeping && owned.fulfillmentIssued && authority.initial?.pendingCommit())) { owned.cancel("cancelled"); fail("cancelled"); }
      };
      const bounded = async <T>(task: Promise<T>, bookkeeping = false): Promise<T> => { const value = await Promise.race([task, aborted]); checkpoint(bookkeeping); return value; };
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method())) fail("method-unavailable");
      const raw = await bounded(request.headersArray());
      if (!Array.isArray(raw) || raw.length > LIMIT.headerFields) fail("request-headers");
      browserRawHeaderBudget(raw.flatMap(({ name, value }) => [name, value]), "request-headers");
      const headers = await bounded(request.allHeaders()), url = new URL(request.url()), foreign = url.origin !== options.origin;
      {
        const cookies = await bounded(options.cookies(request.url()));
        if (!Array.isArray(cookies)) fail("cookie-profile-unavailable");
        if (foreign || options.engine === "webkit" || options.ownership === "attached") {
          if (cookies.length || headers.cookie) fail(foreign ? "cross-origin-cookie-unavailable" : "cookie-profile-unavailable");
        } else browserControlledCookies(cookies, headers.cookie, url);
      }
      if (foreign) {
        if (options.engine !== "chromium" || options.ownership !== "owned" || options.foreignQualified !== true) fail("foreign-profile-unavailable");
        if (!["GET", "HEAD"].includes(request.method())) fail("cross-origin-method");
        browserForeignHeaderValues(raw, headers);
        const native = new Set(["accept", "accept-language", "content-language", "content-type", "origin", "referer", "user-agent", "host", "connection", "accept-encoding", "dnt"]);
        for (const key of Object.keys(headers)) if (!native.has(key) && !key.startsWith("sec-")) fail("cross-origin-headers");
      }
      if (headers.authorization || headers["proxy-authorization"]) fail("authentication-unavailable");
      const data = request.postDataBuffer(); if (data && data.length > LIMIT.requestBody) fail("request-body-limit"); checkpoint();
      const outgoing: Record<string, string> = { ...headers, "accept-encoding": "identity" };
      for (const key of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]) delete outgoing[key];
      if (data) outgoing["content-length"] = String(data.length);
      const response = await bounded(new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
        const send = url.protocol === "https:" ? https.request : http.request;
        checkpoint();
        owned.socket = send(url, { method: request.method(), headers: outgoing, agent: false, maxHeaderSize: LIMIT.headers, rejectUnauthorized: true }, incoming => {
          owned.incoming = incoming;
          const refuseResponse = (code: BrowserHttpRefusal) => { owned.cancel(code); reject(new BrowserTransportRefusal(code)); };
          try { checkpoint(); browserRawHeaderBudget(incoming.rawHeaders, "response-headers"); }
          catch (error) { refuseResponse(error instanceof BrowserTransportRefusal ? error.code : "response-headers"); return; }
          const status = incoming.statusCode || 0;
          if (status >= 300 && status < 400) { refuseResponse("redirect-unavailable"); return; }
          if ((options.engine === "webkit" || options.ownership === "attached" || foreign) && incoming.headers["set-cookie"]) { refuseResponse("set-cookie-profile-unavailable"); return; }
          try { browserControlledSetCookie(incoming.rawHeaders, url); } catch { refuseResponse("set-cookie-profile-unavailable"); return; }
          if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") { refuseResponse("compressed-response-unavailable"); return; }
          if (/attachment/i.test(incoming.headers["content-disposition"] || "")) { refuseResponse("download-unavailable"); return; }
          const declared = incoming.headers["content-length"];
          if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LIMIT.responseBody || Number(declared) > LIMIT.totalBody - total)) { refuseResponse("response-length"); return; }
          let length = 0;
          incoming.on("data", (chunk: Buffer) => {
            if (owned.cancelled || closed) return;
            if (total + chunk.length > LIMIT.totalBody) { close("body-total-limit"); refuseResponse("body-total-limit"); return; }
            if (length + chunk.length > LIMIT.responseBody) { refuseResponse("response-body-limit"); return; }
            length += chunk.length; total += chunk.length; owned.chunks.push(chunk);
          });
          incoming.on("error", () => reject(new BrowserTransportRefusal("transport-unavailable")));
          incoming.on("aborted", () => reject(new BrowserTransportRefusal("incomplete-response")));
          incoming.on("end", () => {
            try { checkpoint(); if (!incoming.complete) fail("incomplete-response"); } catch (error) { reject(error instanceof Error ? error : new BrowserTransportRefusal("transport-unavailable")); return; }
            const fulfilled: Record<string, string> = {};
            for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined && !["connection", "keep-alive", "transfer-encoding", "trailer", "content-length"].includes(key)) fulfilled[key] = Array.isArray(value) ? value.join("\n") : value;
            if (headers.origin && headers.origin !== url.origin && !Object.hasOwn(fulfilled, "access-control-allow-origin")) fulfilled["access-control-allow-origin"] = "";
            const body = Buffer.concat(owned.chunks, length); owned.chunks.length = 0; resolve({ status, headers: fulfilled, body });
          });
        });
        pending.add(owned.socket); owned.socket.on("error", () => reject(new BrowserTransportRefusal("transport-unavailable"))); owned.socket.on("close", () => pending.delete(owned.socket!));
        checkpoint(); owned.socket.end(data || undefined);
      }));
      checkpoint(); owned.fulfillmentIssued = true;
      await bounded(route.fulfill(response), !!authority.initial);
      if (authority.initial && !await bounded(authority.initial.acknowledge(), true)) fail("cancelled");
      completed = increment(completed); remember({ result: "completed", status: response.status, bytes: response.body.length });
      acknowledged = true;
    } catch (error) { await refuse(operation?.cancelled ?? (error instanceof BrowserTransportRefusal ? error.code : "transport-unavailable")); }
    finally { if (operation) { operation.authority.initial?.finish(acknowledged); clearTimeout(operation.timer); operation.chunks.length = 0; operation.incoming?.destroy(); operation.socket?.destroy(); operations.delete(operation); active--; } }
  };
  return { handler, close, fence, proof: () => ({ maximum, active, attempts, beyondLimit, total, pending: pending.size, closed, loss, counts: { ...counts }, completed,
    records: records.map(record => ({ ...record })), retainedBodyChunks: [...operations].reduce((sum, operation) => sum + operation.chunks.length, 0), openResponseStreams: [...operations].filter(operation => operation.incoming && !operation.incoming.destroyed).length }) };
}
