import { expect, test } from "bun:test";
import { observeCompletion } from "../src/claims/report";
import { COMPLETION_DETECTOR, COMPLETION_LIMITS } from "../src/claims/protocol";
import { COMPLETION_HOSTILE, COMPLETION_POSITIVE, COMPLETION_PROSE } from "./fixtures/claims-prose";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import type { EvidenceSetView } from "../src/evaluations/evidence-protocol";

const selected = { attachment: { kind: "run" as const, id: "claims-run" }, setId: "selected-set", revision: 1 };
function report(summary: string, assertions: unknown[] = []) {
  return observeCompletion({ enabled: true, ...selected, summary, assertions }, null);
}
test("disabled observer never accesses summary, evidence, assertions or selected scope", () => {
  const value = { enabled: false, get summary(): string { throw Error("summary processed while disabled"); }, get assertions(): never { throw Error("assertions processed while disabled"); } };
  const view = new Proxy({}, { get() { throw Error("evidence accessed while disabled"); } });
  expect(observeCompletion(value, view as EvidenceSetView)).toEqual({ version: 1, detectorVersion: COMPLETION_DETECTOR, state: "disabled" });
});
for (const fixture of COMPLETION_PROSE) test(`R20/R21 ${fixture.id} retains exact text/context without a success or accusation verdict`, () => {
  const result = report(fixture.text); expect(result.state).toBe("enabled"); if (result.state !== "enabled") return;
  expect(result.observations.length).toBeGreaterThan(0);
  for (const item of result.observations) {
    expect(item.category).toBe(fixture.category); expect(item.state).toBe("ambiguous_text");
    expect(fixture.text.slice(item.origin.start, item.origin.end)).toStartWith(item.snippet);
    expect(item.origin.sha256).toBe(evidenceDigest(fixture.text)); expect(item.authentication).toBe("not_authenticated");
    expect(item.reportedOutcome).toBeNull(); expect(item.reference).toBeNull();
  }
  expect(result.authority).toBe("report_only");
});
test("plain positive prose is unsupported without explicit linked evidence; unrelated prose remains uncovered", () => {
  const result = report(COMPLETION_POSITIVE + "\nThere is a cat."); if (result.state !== "enabled") throw Error("unexpected disabled");
  expect(result.observations).toHaveLength(1); expect(result.observations[0].state).toBe("unsupported_claim");
  expect(result.coverage.uncoveredBytes).toBeGreaterThan(0);
});
test("task segmentation never lends one task's evidence to another task", () => {
  const result = report("- [x] All tests pass\n- [ ] All tests pass\nIf tests pass, deploy.\nAll tests pass."); if (result.state !== "enabled") throw Error("unexpected disabled");
  expect(result.observations.map(item => item.category)).toEqual(["checked_task", "unchecked_task", "conditional", "prose"]);
  expect(result.observations.map(item => item.state)).toEqual(["ambiguous_text", "ambiguous_text", "ambiguous_text", "unsupported_claim"]);
});
test("bounded parsing discloses omitted bytes and observations and never returns a clean clipped report", () => {
  const result = report("All tests pass.\n".repeat(1800)); if (result.state !== "enabled") throw Error("unexpected disabled");
  expect(result.source.partial).toBe(true); expect(result.source.inspectedBytes).toBeLessThanOrEqual(COMPLETION_LIMITS.INSPECT_BYTES);
  expect(result.observations).toHaveLength(32); expect(result.coverage.observationLimitReached).toBe(true); expect(result.coverage.uncoveredBytes).toBeGreaterThan(0);
});
test("UTF8 snippets retain exact full-source hash and both character and byte intervals", () => {
  const text = "🐾 ".repeat(300) + "All tests pass."; const result = report(text); if (result.state !== "enabled") throw Error("unexpected disabled");
  const item = result.observations[0]; expect(Buffer.byteLength(item.snippet)).toBeLessThanOrEqual(512); expect(item.snippetTruncated).toBe(true);
  expect(text.slice(item.origin.start, item.origin.end)).toStartWith(item.snippet); expect(item.origin.byteEnd).toBe(Buffer.byteLength(text)); expect(item.origin.end).toBe(text.length); expect(result.source.sha256).toBe(evidenceDigest(text));
});
test("unknown and mismatched structured references do not fetch anything or inherit authority", () => {
  const result = report(COMPLETION_POSITIVE, [{ text: COMPLETION_POSITIVE, reference: { setId: "other-set", revision: 1, sourceId: "remote" } }, { text: COMPLETION_POSITIVE, reference: { setId: "selected-set", revision: 1, sourceId: "absent" } }]);
  if (result.state !== "enabled") throw Error("unexpected disabled");
  expect(result.observations.slice(0, 2).map(item => item.state)).toEqual(["scope_mismatch", "evidence_missing"]);
});
test("hostile text is inert data and has no process/network/provider capability", () => {
  const before = Bun.spawn; const fetched = globalThis.fetch;
  try { Bun.spawn = (() => { throw Error("content-derived process"); }) as typeof Bun.spawn; globalThis.fetch = (() => { throw Error("content-derived network"); }) as typeof fetch;
    const result = report(COMPLETION_HOSTILE); expect(JSON.stringify(result)).toContain("observer.invalid");
  } finally { Bun.spawn = before; globalThis.fetch = fetched; }
});
test("input, duplicate references, structural override and assertion bounds are refused", () => {
  expect(() => report("a".repeat(COMPLETION_LIMITS.INPUT_BYTES + 1))).toThrow();
  const assertion = { text: "All tests pass.", reference: { setId: "selected-set", revision: 1, sourceId: "report" } };
  expect(() => report("", [assertion, assertion])).toThrow("duplicate");
  expect(() => observeCompletion({ enabled: true, ...selected, summary: "", assertions: [], projectId: "body-project" }, null)).toThrow();
  expect(() => report("", Array.from({ length: 33 }, (_, index) => ({ ...assertion, reference: { ...assertion.reference, sourceId: String(index) } })))).toThrow();
});
