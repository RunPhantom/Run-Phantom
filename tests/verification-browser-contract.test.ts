import { describe, expect, test } from "bun:test";
import { boundReportContext, reopenExecutionContext } from "../src/verification/report-context";
import type { VerificationReportContext } from "../src/verification/protocol";
import { parseBrowserAction, parseBrowserOpen, parseBrowserTarget, parseWorkerFrame, parseExecutionContext, scrubBrowserSecrets, BROWSER_LIMITS } from "../src/verification/browser-contract";

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
  test("optional execution yields to the exact context byte budget and old saved context stays byte-identical", () => {
    const checks: VerificationReportContext["checks"] = Array.from({ length: 20 }, (_, index) => ({ step: index + 1, predicate: { kind: "console", level: "error", absent: true }, status: index % 2 ? "fail" : "pass", reason: "汉".repeat(1000), since: 1, through: 5, generation: 1, coverage: { network: true, console: true, dom: true, state: true, signal: true, route: true }, complete: true, dropped: 0, settled: true }));
    const input = { origin: "http://localhost:4812", quietMs: 300, redacted: false, truncated: false, checks };
    const original = JSON.stringify(input); expect(reopenExecutionContext(input)).toBe(input); expect(JSON.stringify(reopenExecutionContext(input))).toBe(original);
    const control = boundReportContext(input); expect(Buffer.byteLength(JSON.stringify(control))).toBe(65514);
    const execution = { formatVersion: 1 as const, backend: "trusted-browser" as const, engine: "chromium" as const, providerVersion: "1.62.1", ownership: "owned" as const, generation: 1, inputMode: "trusted-browser" as const, dispatch: "completed" as const };
    const result = boundReportContext({ ...input, execution }); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536); expect(result.execution).toBeUndefined(); expect(result.executionOmitted).toBe("context-limit"); expect(result.checks).toHaveLength(20);
    for (let index = 0; index < 20; index++) { const { predicate: _predicate, reason: _reason, ...mandatory } = result.checks[index]; const { predicate: _oldPredicate, reason: _oldReason, ...expected } = checks[index]; expect(mandatory).toEqual(expected); }
    expect(JSON.stringify(input)).toBe(original); expect(boundReportContext(result)).toEqual(result);
    const reopened = reopenExecutionContext({ ...control, execution: { ...execution, token: "unsafe-live-authority" } } as VerificationReportContext);
    expect(reopened.execution).toBeUndefined(); expect(reopened.executionOmitted).toBe("invalid"); expect(reopened.checks).toEqual(control.checks); expect(JSON.stringify(reopened)).not.toContain("unsafe-live-authority");
  });

  test("short entered values and overlapping redaction markers remain private and bounded", () => {
    expect(scrubBrowserSecrets("Controlled echo: 猫", ["猫"])).toBe("Controlled echo: [REDACTED]");
    expect(scrubBrowserSecrets("R E REDACTED", ["R", "E", "REDACTED"])).toBe("[REDACTED] [REDACTED] [REDACTED]");
    expect(scrubBrowserSecrets("literal .* [a]", [".*", "[a]"])).toBe("literal [REDACTED] [REDACTED]");
    expect(scrubBrowserSecrets("x".repeat(16385), ["x"])).toBe("[TRUNCATED]");
  });

});
