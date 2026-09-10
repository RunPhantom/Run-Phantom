import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect } from "../src/verification/browser/index";
import { installNetwork } from "../src/verification/browser/observers/network";
import { installConsole } from "../src/verification/browser/observers/console";
import { runDomCommand } from "../src/verification/browser/actions/index";
import type { Emit } from "../src/verification/browser/observers/types";
import { parseBrowserMessage } from "../src/verification/validation";
import { evaluatePredicate } from "../src/verification/predicates";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<Record<string, any>> = [];
  constructor(readonly url: URL) { super(); FakeSocket.sockets.push(this); }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(text: string): void { this.sent.push(JSON.parse(text)); }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(message: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
}
class FakeXhr extends EventTarget {
  status = 0;
  open(_method: string, _url: string): void { /* Native request setup stand-in. */ }
  send(): void { /* Explicit completion lets tests control request ordering. */ }
  complete(status: number): void { this.status = status; this.dispatchEvent(new Event("loadend")); }
}
const restored = new Map<string, PropertyDescriptor | undefined>();
const cleanup: Array<() => void> = [];
let window_: EventTarget & { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
let consoleCalls: unknown[][];
function globalValue(name: string, value: unknown): void {
  restored.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
beforeEach(() => {
  FakeSocket.sockets = [];
  consoleCalls = [];
  window_ = Object.assign(new EventTarget(), { fetch: () => Promise.resolve(new Response("ok")) });
  globalValue("window", window_);
  globalValue("location", new URL("http://localhost:4567"));
  globalValue("history", { pushState() {}, replaceState() {} });
  globalValue("document", { querySelectorAll: () => [] });
  globalValue("XMLHttpRequest", FakeXhr);
  globalValue("WebSocket", FakeSocket);
  const log = (...args: unknown[]): void => { consoleCalls.push(args); };
  globalValue("console", { log, warn: log, error: log, info: log, debug: log });
});
afterEach(() => {
  for (const finish of cleanup.splice(0).reverse()) finish();
  for (const [name, descriptor] of restored) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  restored.clear();
});

function connection(): { runtime: ReturnType<typeof connect>; socket: FakeSocket } {
  const runtime = connect({ url: "http://localhost:5947", sessionId: "session_test", token: "unit-credential-test" });
  cleanup.push(() => runtime.disconnect());
  const socket = FakeSocket.sockets.at(-1)!;
  socket.open();
  return { runtime, socket };
}

describe("the browser capture boundaries", () => {
  test("request completion retains the original action, including requests before any action", async () => {
    const pending: Array<(response: Response) => void> = [];
    window_.fetch = () => new Promise((resolve) => pending.push(resolve));
    const events: Array<{ type: string; actionId?: string | null; data: Record<string, unknown> }> = [];
    let actionId: string | undefined;
    cleanup.push(installNetwork((type, data, action) => events.push({ type, data, actionId: action }), () => actionId));
    const unscoped = window_.fetch("/before");
    actionId = "first";
    const first = window_.fetch("/first");
    actionId = "second";
    pending[1](new Response("ok", { status: 201 }));
    pending[0](new Response("ok"));
    await Promise.all([unscoped, first]);
    const completions = events.filter((event) => event.type === "network");
    expect(completions.map((event) => event.actionId)).toEqual(["first", null]);
    expect(completions[0].data.requestId).toBe(events[1].data.requestId);
  });

  test("XHR captures at send, emits one completion per reuse, and keeps original action IDs", () => {
    const events: Array<{ type: string; data: Record<string, unknown>; actionId?: string | null }> = [];
    let actionId = "open-action";
    cleanup.push(installNetwork((type, data, action) => events.push({ type, data, actionId: action }), () => actionId));
    const xhr = new FakeXhr();
    xhr.open("GET", "/details");
    actionId = "send-action";
    xhr.send();
    actionId = "later-action";
    xhr.complete(200);
    xhr.open("POST", "/other");
    xhr.send();
    xhr.complete(500);
    expect(events.map((event) => event.type)).toEqual(["network.start", "network", "network.start", "network"]);
    expect(events[1].actionId).toBe("send-action");
    expect(events[3].actionId).toBe("later-action");
    expect(events[0].data.requestId).toBe(events[1].data.requestId);
    expect(events[2].data.requestId).not.toBe(events[0].data.requestId);
  });

  test("throwing observations preserve fetch fulfillment, rejection, response body, and console invocation", async () => {
    const response = new Response("application result");
    const rejection = new TypeError("Application network failure");
    window_.fetch = (input) => input === "/failed" ? Promise.reject(rejection) : Promise.resolve(response);
    const throwing: Emit = () => { throw new Error("Observer fault"); };
    cleanup.push(installNetwork(throwing, () => undefined));
    cleanup.push(installConsole(throwing));
    const observed = await window_.fetch("/ok");
    expect(observed).toBe(response);
    console.error("application message");
    expect(consoleCalls).toEqual([["application message"]]);
    expect(await observed.text()).toBe("application result");
    const observedRejection: unknown = await window_.fetch("/failed").then(() => null, (error: unknown) => error);
    expect(observedRejection).toBe(rejection);
  });

  test("pre-ready observations are bounded and retain the start of a pending request", async () => {
    let resolve!: (response: Response) => void;
    window_.fetch = () => new Promise((done) => { resolve = done; });
    const { socket } = connection();
    const request = window_.fetch("/pending");
    expect(socket.sent.map((message) => message.type)).toEqual(["hello"]);
    socket.receive({ type: "ready" });
    expect(socket.sent[1].event.type).toBe("network.start");
    resolve(new Response("ok"));
    await request;
    expect(socket.sent[2].event.type).toBe("network");
    expect(socket.sent[1].event.data.requestId).toBe(socket.sent[2].event.data.requestId);
  });

  test("a final dropped console event disconnects immediately instead of hiding evidence loss", () => {
    const { runtime, socket } = connection();
    socket.receive({ type: "ready" });
    socket.bufferedAmount = 300_000;
    console.error("last error before silence");
    expect(socket.readyState).toBe(3);
    expect(() => runtime.signal("later")).toThrow("disconnected");
    expect(consoleCalls).toEqual([["last error before silence"]]);
  });

  test("pre-ready queue overflow disconnects without requiring another observation", () => {
    const { runtime, socket } = connection();
    for (let index = 0; index < 101; index++) console.log("queued");
    expect(socket.readyState).toBe(3);
    expect(() => runtime.registerStore("next", () => ({}))).toThrow("disconnected");
  });

  test("lone surrogate fill values cannot poison future event serialization", () => {
    const { runtime, socket } = connection();
    socket.receive({ type: "ready" });
    // The target is missing; the supplied value still entered the redaction set first.
    socket.receive({ type: "command", id: "fill_one", command: { type: "fill", selector: "#missing", value: "\ud800" } });
    expect(socket.sent.at(-1)?.ok).toBe(false);
    runtime.signal("after.fill", { value: "\ud800" });
    expect(socket.readyState).toBe(1);
    expect(socket.sent.at(-1)?.event.data.name).toBe("after.fill");
    expect(socket.sent.at(-1)?.event.data.data.value).toBe("[REDACTED]");
    expect(socket.sent.at(-1)?.event.truncated).toBe(true);
  });

  test("truncated DOM labels never expose a partial credential", () => {
    const credential = `sk-proj-${"x".repeat(80)}`;
    const label = `${"prefix ".repeat(32)}${credential}`;
    const element = {
      getAttribute: (name: string) => name === "aria-label" ? label : null,
      matches: () => false, tagName: "BUTTON", id: "test", ownerDocument: {}, textContent: "",
    };
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { querySelectorAll: () => [element] } });
    const snapshot = runDomCommand({ type: "snapshot" });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("sk-proj-");
    expect(snapshot.truncated).toBe(true);
  });

  test("long arbitrary fills are redacted before string, structured log, and label truncation", () => {
    const { runtime, socket } = connection();
    socket.receive({ type: "ready" });
    const secret = `arbitrary-${"Z".repeat(4080)}`;
    socket.receive({ type: "command", id: "fill_long", command: { type: "fill", selector: "#missing", value: secret } });
    runtime.registerStore("long", () => ({ value: `prefix ${secret} suffix`, count: 12, valid: true }));
    console.log({ value: `prefix ${secret} suffix` });
    socket.receive({ type: "command", id: "state_long", command: { type: "state", store: "long" } });
    expect(socket.sent.at(-1)?.result.value.count).toBe(12);
    expect(socket.sent.at(-1)?.result.value.valid).toBe(true);
    expect(socket.sent.at(-1)?.truncated).toBe(true);
    const element = {
      getAttribute: (name: string) => name === "aria-label" ? `${"prefix ".repeat(32)}${secret}` : null,
      matches: () => false, tagName: "BUTTON", id: "test", ownerDocument: {}, textContent: "",
    };
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { querySelectorAll: () => [element] } });
    socket.receive({ type: "command", id: "snapshot_long", command: { type: "snapshot" } });
    expect(JSON.stringify(socket.sent)).not.toContain("ZZZZZZZZ");
    expect(socket.readyState).toBe(1);
  });

  test("short fills preserve numeric and boolean evidence fields", () => {
    const { runtime, socket } = connection();
    socket.receive({ type: "ready" });
    for (const [index, value] of ["1", "e", "true"].entries()) {
      socket.receive({ type: "command", id: `fill_${index}`, command: { type: "fill", selector: "#missing", value } });
    }
    runtime.registerStore("short", () => ({ count: 1, checked: true, name: "event", exact: "e" }));
    socket.receive({ type: "command", id: "read_short", command: { type: "state", store: "short" } });
    const result = socket.sent.at(-1)?.result.value;
    expect(result).toEqual({ count: 1, checked: true, name: "event", exact: "[REDACTED]" });
    expect(socket.readyState).toBe(1);
  });

  test("reserved fill words preserve protocol schemas and cannot hide a subsequent console error", async () => {
    const { runtime, socket } = connection();
    socket.receive({ type: "ready" });
    const reserved = ["console", "error", "pass", "fail", "network", "GET", "name", "value", "count", "store", "message", "type", "level", "fetch", "n1"];
    for (const [index, value] of reserved.entries()) {
      socket.receive({ type: "command", id: `reserved_${index}`, command: { type: "fill", selector: "#missing", value } });
    }
    runtime.registerStore("error", () => ({ hint: "error", amount: 1, checked: true }));
    socket.receive({ type: "command", id: "read_reserved", command: { type: "state", store: "error" } });
    expect(socket.sent.at(-1)?.result.store).toBe("error");
    expect(socket.sent.at(-1)?.result.value).toEqual({ hint: "[REDACTED]", amount: 1, checked: true });
    runtime.signal("network", { hint: "error", amount: 1 });
    console.error("Delayed exception");
    await window_.fetch("/metadata");
    const parsed = socket.sent.map((message) => parseBrowserMessage(message));
    const observed = parsed.filter((message) => message.type === "event").map((message, index) => ({ ...message.event, t: index + 1 }));
    expect(observed.find((event) => event.type === "console")?.data.level).toBe("error");
    expect(observed.find((event) => event.type === "signal")?.data.name).toBe("network");
    const network = observed.find((event) => event.type === "network");
    expect(network?.data).toMatchObject({ method: "GET", requestId: "n1", status: 200, ok: true, initiator: "fetch" });
    const verdict = evaluatePredicate({ kind: "console", level: "error", absent: true }, {
      events: observed, coverage: { network: true, console: true, dom: true, state: true, signal: true, route: true }, complete: true, settled: true,
    });
    expect(verdict.status).toBe("fail");
    expect(socket.readyState).toBe(1);
  });

  test("provider-shaped credentials in signal and store identities are redacted at source", () => {
    const { runtime, socket } = connection();
    socket.receive({ type: "ready" });
    const credential = `sk-proj-${"test".repeat(12)}`;
    runtime.signal(credential);
    expect(socket.sent.at(-1)?.event.data.name).toBe("[REDACTED]");
    expect(socket.sent.at(-1)?.event.truncated).toBe(true);
    runtime.registerStore(credential, () => ({ checked: true }));
    socket.receive({ type: "command", id: "read_sensitive_name", command: { type: "state", store: credential } });
    expect(socket.sent.at(-1)?.result.store).toBe("[REDACTED]");
    expect(socket.sent.at(-1)?.truncated).toBe(true);
    expect(JSON.stringify(socket.sent)).not.toContain(credential);
    expect(() => socket.sent.forEach(parseBrowserMessage)).not.toThrow();
  });

  test("store loss metadata is carried to command results and later wrappers survive teardown", async () => {
    const { runtime, socket } = connection();
    runtime.registerStore("state", () => ({ password: "unit-only-secret", items: Array(120).fill("item") }));
    socket.receive({ type: "ready" });
    socket.receive({ type: "command", id: "read_one", command: { type: "state", store: "state" } });
    expect(socket.sent.at(-1)?.truncated).toBe(true);
    expect(JSON.stringify(socket.sent)).not.toContain("unit-only-secret");
    const captured = window_.fetch;
    const later = (...args: Parameters<typeof captured>): Promise<Response> => captured(...args);
    window_.fetch = later;
    runtime.disconnect();
    runtime.disconnect();
    expect(window_.fetch).toBe(later);
    expect((await window_.fetch("/after")).ok).toBe(true);
    expect(() => runtime.registerStore("x", () => 1)).toThrow("disconnected");
  });
});
