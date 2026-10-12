import { describe, expect, test } from "bun:test";
import { parseBrowserAction, parseBrowserOpen, parseBrowserTarget, parseWorkerFrame, parseExecutionContext, BROWSER_LIMITS } from "../src/verification/browser-contract";

describe("trusted-browser closed authority boundary", () => {
  test("owned configuration accepts an exact local page and refuses executable authority", () => {
    expect(parseBrowserOpen({ engine: "chromium", url: "http://127.0.0.1:8765/pay" })).toEqual({ engine: "chromium", url: "http://127.0.0.1:8765/pay", recordVideo: false });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "http://u:p@localhost:8765", "https://example.com"]) expect(() => parseBrowserOpen({ engine: "chromium", url })).toThrow();
    for (const field of ["module", "executable", "profile", "args", "evaluate", "cdp"]) expect(() => parseBrowserOpen({ engine: "chromium", url: "http://localhost:8765", [field]: "x" })).toThrow();
    expect(() => parseBrowserOpen({ engine: "chromium", url: "http://localhost:8765", recordVideo: true })).toThrow();
    expect(parseBrowserOpen({ engine: "firefox", url: "http://localhost:8765", recordVideo: true, rawConsent: true }).recordVideo).toBe(true);
  });
  test("targets are literal and never accept persisted identity or accessor execution", () => {
    expect(parseBrowserTarget({ kind: "role", role: "button", name: "Pay" })).toEqual({ kind: "role", role: "button", name: "Pay", exact: true });
    for (const target of [{ ref: "rpref_" + "a".repeat(32) }, { kind: "css", selector: "#x", index: 0 }, { kind: "css", selector: "x".repeat(1025) }, { kind: "css", selector: "iframe >> internal:control=enter-frame >> button" }]) expect(() => parseBrowserTarget(target)).toThrow();
    let reads = 0;
    const target = { kind: "css", get selector() { reads++; return "#x"; } };
    expect(() => parseBrowserTarget(target)).toThrow();
    expect(reads).toBe(0);
  });
  test("finite actions reject fallback, timeout growth, uploads and excess text", () => {
    expect(parseBrowserAction({ type: "fill", target: { kind: "css", selector: "#name" }, value: "new" }).type).toBe("fill");
    for (const action of [{ type: "evaluate", code: "1" }, { type: "press", target: { kind: "css", selector: "#x" }, key: "Meta+Q" }, { type: "click", target: { kind: "css", selector: "#x" }, timeout: 60000 }, { type: "fill", target: { kind: "css", selector: "#x" }, value: "a".repeat(4097) }]) expect(() => parseBrowserAction(action)).toThrow();
  });
  test("worker wire fences version, nonce, generation, frames and unknown fields", () => {
    const frame = { formatVersion: 1, nonce: "a".repeat(64), id: "b".repeat(32), generation: 1, operation: "observe", data: {} };
    expect(parseWorkerFrame(JSON.stringify(frame), frame.nonce).operation).toBe("observe");
    for (const change of [{ formatVersion: 2 }, { nonce: "c".repeat(64) }, { generation: -1 }, { operation: "evaluate" }, { path: "/tmp/x" }]) expect(() => parseWorkerFrame(JSON.stringify({ ...frame, ...change }), frame.nonce)).toThrow();
    expect(() => parseWorkerFrame(" ".repeat(BROWSER_LIMITS.FRAME_BYTES + 1), frame.nonce)).toThrow();
  });
  test("saved execution metadata remains closed and inert", () => {
    const source = { formatVersion: 1, backend: "trusted-browser", engine: "chromium", providerVersion: "1.62.1", ownership: "owned", generation: 3, inputMode: "trusted-browser", dispatch: "completed", actionId: "a".repeat(32), artifactIds: [] };
    expect(parseExecutionContext(source)).toEqual(source);
    for (const change of [{ token: "secret" }, { module: "/private/x" }, { sessionId: "live" }, { artifactIds: ["/tmp/x"] }, { generation: -1 }]) expect(() => parseExecutionContext({ ...source, ...change })).toThrow();
    let reads = 0; const ids = ["unused"]; Object.defineProperty(ids, "0", { get() { reads++; return "unused"; } });
    expect(() => parseExecutionContext({ ...source, artifactIds: ids })).toThrow(); expect(reads).toBe(0);
  });
});
