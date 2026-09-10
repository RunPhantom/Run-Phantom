/**
 * Network observer.
 *
 * Records fetch and XHR as metadata only, emitting `network.start` when a request
 * leaves and `network` when it settles. Request and response bodies are never
 * captured. A request carries the id of the action that started it, so a completion
 * can be matched to the step that caused it rather than guessed at by timing.
 * Response streams sit outside observer coverage and are declared as such instead of
 * being silently omitted.
 */
import { captureMethod } from "../patching/capture-method.js";
import { redactUrl } from "../../redaction.js";
import { observeSafely, observerFailure, type Emit, type Teardown } from "./types.js";

interface RequestMeta {
  requestId: string;
  method: string;
  url: string;
  start: number;
  actionId?: string;
}
function statusIsOk(status: number): boolean { return status >= 200 && status < 400; }
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

export function installNetwork(emit: Emit, getActionId: () => string | undefined): Teardown {
  const origFetch = captureMethod(window, "fetch");
  const callFetch = origFetch.bind(window);
  const proto = XMLHttpRequest.prototype;
  const origOpen = captureMethod(proto, "open");
  const origSend = captureMethod(proto, "send");
  const callOpen = origOpen as (this: XMLHttpRequest, ...args: unknown[]) => void;
  let active = true;
  let sequence = 0;
  const failure = observerFailure(emit, "network");
  const makeMeta = (url: string, method: string): RequestMeta => ({
    requestId: `n${++sequence}`, method, url: redactUrl(new URL(url, location.href).href),
    start: performance.now(), actionId: getActionId(),
  });
  const start = (meta: RequestMeta, initiator: "fetch" | "xhr"): void => {
    if (active) emit("network.start", {
      requestId: meta.requestId, url: meta.url, method: meta.method, initiator,
    }, meta.actionId ?? null);
  };
  const finish = (meta: RequestMeta, initiator: "fetch" | "xhr", status: number): void => {
    if (active) emit("network", {
      requestId: meta.requestId, url: meta.url, method: meta.method,
      status, ok: statusIsOk(status), durationMs: Math.max(0, Math.round(performance.now() - meta.start)), initiator,
    }, meta.actionId ?? null);
  };
  const patchedFetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!active) return callFetch(input, init);
    let meta: RequestMeta | undefined;
    observeSafely(() => {
      meta = makeMeta(urlOf(input), methodOf(input, init));
      start(meta, "fetch");
    }, failure);
    let result: Promise<Response>;
    try { result = callFetch(input, init); } catch (error) {
      observeSafely(() => { if (meta) finish(meta, "fetch", 0); }, failure);
      throw error;
    }
    // Return the observed chain and rethrow the original rejection. Attaching a rejection
    // side observer while returning the original promise would suppress unhandledrejection.
    return result.then(
      (response) => {
        observeSafely(() => { if (meta) finish(meta, "fetch", response.status); }, failure);
        return response;
      },
      (error: unknown) => {
        observeSafely(() => { if (meta) finish(meta, "fetch", 0); }, failure);
        throw error;
      },
    );
  }) as typeof window.fetch;

  const meta = new WeakMap<XMLHttpRequest, { url: string; method: string }>();
  const pending = new Map<XMLHttpRequest, () => void>();
  const patchedOpen = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
    // open() can abort an earlier request; let its loadend consume the old identity first.
    callOpen.call(this, method, url, ...rest);
    observeSafely(() => {
      if (active) meta.set(this, { method: method.toUpperCase(), url: String(url) });
    }, failure);
  } as XMLHttpRequest["open"];
  const patchedSend: XMLHttpRequest["send"] = function (this: XMLHttpRequest, body): void {
    let cleanup: (() => void) | undefined;
    let request: RequestMeta | undefined;
    observeSafely(() => {
      if (!active || pending.has(this)) return;
      const source = meta.get(this);
      if (!source) { failure(); return; }
      if (pending.size >= 1000) { failure(); return; }
      request = makeMeta(source.url, source.method);
      const current = request;
      const onLoadEnd = (): void => {
        cleanup?.();
        observeSafely(() => finish(current, "xhr", this.status), failure);
      };
      cleanup = () => {
        this.removeEventListener("loadend", onLoadEnd);
        pending.delete(this);
      };
      this.addEventListener("loadend", onLoadEnd);
      pending.set(this, cleanup);
      start(current, "xhr");
    }, failure);
    try { origSend.call(this, body ?? null); } catch (error) {
      observeSafely(() => {
        cleanup?.();
        if (request) finish(request, "xhr", 0);
      }, failure);
      throw error;
    }
  };
  const teardown = (): void => {
    active = false;
    if (window.fetch === patchedFetch) window.fetch = origFetch;
    if (proto.open === patchedOpen) proto.open = origOpen;
    if (proto.send === patchedSend) proto.send = origSend;
    for (const cleanup of pending.values()) observeSafely(cleanup);
    pending.clear();
  };
  try {
    window.fetch = patchedFetch;
    proto.open = patchedOpen;
    proto.send = patchedSend;
  } catch (error) {
    observeSafely(teardown);
    throw error;
  }
  return teardown;
}
