import { describe, expect, test } from "bun:test";
import { captureBaselineReading, captureCausalAttribution, type BaselineScope, type CausalAttribution, type OperationReading } from "../src/verification/baseline";
import { evaluateCausalPredicate, evaluatePredicate, type CausalPredicate, type CausalPredicateContext } from "../src/verification/predicates";

const scope: BaselineScope = { sessionId: "app-1", generation: 2, kind: "state", target: "cart", path: "saved" };
const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const baselineFields = { baselineCursor: 100, baselineValue: false };
const predicate: CausalPredicate = { scope, relation: "becomes", equals: true };
const context = (beforeValue: unknown, afterValue: unknown, overrides: Partial<CausalPredicateContext> = {}): CausalPredicateContext => {
  const before = captureBaselineReading({ scope, cursor: 100, complete: true, fresh: true }, beforeValue);
  const after = captureBaselineReading({ scope, cursor: 120, complete: true, fresh: true, actionId: "click-1" }, afterValue);
  const attribution = captureCausalAttribution({ type: "action.result", t: 121, actionId: "click-1", data: { scope, baselineCursor: 100, baselineValue: beforeValue, readingCursor: 120, value: afterValue } });
  return { before, after, action: { id: "click-1", sessionId: "app-1", generation: 2, cursor: 110, acknowledged: true },
    through: 130, complete: true, coverage, settled: true, attribution, ...overrides };
};

const evaluate = (before: unknown, after: unknown, overrides: Partial<CausalPredicateContext> = {}) => evaluateCausalPredicate(predicate, context(before, after, overrides));

describe("causal baseline-relative predicates", () => {
  test("a healthy scoped action transition passes and its contrary completed result fails", () => {
    const passed = evaluate(false, true);
    expect(passed.status).toBe("pass");
    expect(passed.evidence.map((event) => event.data.phase)).toEqual(["before", "after"]);
    expect(evaluate(false, false).status).toBe("fail");
    expect(evaluate(true, false).status).toBe("fail");
  });

  test("a dead action with already-true state is inconclusive while current-condition checks still pass", () => {
    expect(evaluate(true, true)).toMatchObject({ status: "inconclusive" });
    const actual = evaluatePredicate({ kind: "state", store: "cart", path: "saved", equals: true }, {
      coverage, complete: true, settled: true,
      events: [{ t: 120, type: "state", data: { store: "cart", value: { saved: true } } }],
    });
    expect(actual.status).toBe("pass");
  });

  test("matching wall-time, ordinary actionId tags, a boolean and copied proof do not prove causation", () => {
    const good = context(false, true);
    for (const attribution of [undefined, { causal: true }, { ...good.attribution! },
      { source: "interval-only", actionId: "click-1", cursor: 121 }]) {
      const verdict = evaluateCausalPredicate(predicate, { ...good, attribution: attribution as CausalAttribution | undefined });
      expect(verdict.status).toBe("inconclusive");
      expect(verdict.reason).toContain("interval alone");
    }
    expect(evaluateCausalPredicate(predicate, good).status).toBe("pass");
  });

  test("wrong action, session, document, target and path cannot borrow another result", () => {
    const good = context(false, true);
    const cases: Partial<CausalPredicateContext>[] = [
      { action: { ...good.action, id: "other-action" } }, { action: { ...good.action, sessionId: "other-app" } },
      { action: { ...good.action, generation: 3 } }, { action: { ...good.action, acknowledged: false } },
      { before: captureBaselineReading({ scope: { ...scope, target: "other-cart" }, cursor: 100, complete: true, fresh: true }, false) },
      { after: captureBaselineReading({ scope: { ...scope, path: "other" }, cursor: 120, actionId: "click-1", complete: true, fresh: true }, true) },
      { after: captureBaselineReading({ scope, cursor: 120, actionId: "other-action", complete: true, fresh: true }, true) },
    ];
    for (const overrides of cases) expect(evaluate(false, true, overrides).status).toBe("inconclusive");
  });

  test("a correlated result must own the exact reading cursor, scope and value", () => {
    for (const data of [
      { ...baselineFields, scope: { ...scope, generation: 3 }, readingCursor: 120, value: true },
      { ...baselineFields, scope: { ...scope, target: "other-cart" }, readingCursor: 120, value: true },
      { ...baselineFields, scope, readingCursor: 119, value: true }, { ...baselineFields, scope, readingCursor: 120, value: false },
      { ...baselineFields, scope, baselineCursor: 99, readingCursor: 120, value: true },
      { ...baselineFields, scope, baselineValue: true, readingCursor: 120, value: true },
    ]) {
      const attribution = captureCausalAttribution({ type: "action.result", t: 121, actionId: "click-1", data });
      expect(evaluate(false, true, { attribution }).status).toBe("inconclusive");
    }
    const wrongAction = captureCausalAttribution({ type: "action.result", t: 121, actionId: "other-action", data: { ...baselineFields, scope, readingCursor: 120, value: true } });
    expect(evaluate(false, true, { attribution: wrongAction }).status).toBe("inconclusive");
  });

  test("missing, unreadable, partial, redacted, stale or observer-lost readings remain inconclusive", () => {
    const good = context(false, true);
    const metadata = { scope, cursor: 100, complete: true, fresh: true };
    const cases: Partial<CausalPredicateContext>[] = [
      { before: null }, { after: null }, { complete: false }, { coverage: { ...coverage, state: false } },
      { coverage: { ...coverage, network: false } }, { settled: false },
      { before: captureBaselineReading({ ...metadata, complete: false }, false) },
      { before: captureBaselineReading({ ...metadata, truncated: true }, false) },
      { before: captureBaselineReading({ ...metadata, redacted: true }, false) },
      { before: captureBaselineReading({ ...metadata, fresh: false }, false) },
      { before: captureBaselineReading(metadata, undefined) },
      { before: captureBaselineReading(metadata, "[REDACTED]") },
      { after: captureBaselineReading({ scope, cursor: 120, complete: true, fresh: false, actionId: "click-1" }, true) },
      { action: { ...good.action, cursor: 60_101 }, after: captureBaselineReading({ scope, cursor: 60_102, complete: true, fresh: true, actionId: "click-1" }, true), through: 60_103 },
      { through: 60_121 },
    ];
    for (const overrides of cases) expect(evaluate(false, true, overrides).status).toBe("inconclusive");
  });

  test("pre/post readings must bracket the acknowledged boundary within the observed cursor", () => {
    const metadata = { scope, complete: true, fresh: true };
    for (const overrides of [
      { before: captureBaselineReading({ ...metadata, cursor: 110 }, false) },
      { before: captureBaselineReading({ ...metadata, cursor: 111 }, false) },
      { after: captureBaselineReading({ ...metadata, cursor: 110, actionId: "click-1" }, true) },
      { through: 119 }, { through: NaN },
    ]) expect(evaluate(false, true, overrides).status).toBe("inconclusive");
    const future = captureCausalAttribution({ type: "action.result", t: 131, actionId: "click-1", data: { ...baselineFields, scope, readingCursor: 120, value: true } });
    expect(evaluate(false, true, { attribution: future }).status).toBe("inconclusive");
  });

  test("numerical relative comparisons reject coercion and compare finite values without subtraction overflow", () => {
    const increased: CausalPredicate = { scope, relation: "increased" };
    const decreased: CausalPredicate = { scope, relation: "decreased" };
    expect(evaluateCausalPredicate(increased, context(0, 1)).status).toBe("pass");
    expect(evaluateCausalPredicate(increased, context(1, 1)).status).toBe("fail");
    expect(evaluateCausalPredicate(decreased, context(1, 0)).status).toBe("pass");
    expect(evaluateCausalPredicate(decreased, context(0, 1)).status).toBe("fail");
    expect(evaluateCausalPredicate(increased, context("0", 1)).status).toBe("inconclusive");
    expect(evaluateCausalPredicate(increased, context(-Number.MAX_VALUE, Number.MAX_VALUE)).status).toBe("pass");
  });

  test("structured transitions compare exact values and preserve array multiplicity", () => {
    const expected: CausalPredicate = { scope, relation: "becomes", equals: { items: ["A", "A"] } };
    expect(evaluateCausalPredicate(expected, context({ items: [] }, { items: ["A", "A"] })).status).toBe("pass");
    expect(evaluateCausalPredicate(expected, context({ items: [] }, { items: ["A"] })).status).toBe("fail");
    expect(evaluateCausalPredicate({ scope, relation: "changed" }, context({ a: 1, b: 2 }, { b: 2, a: 1 })).status).toBe("fail");
    expect(evaluateCausalPredicate({ scope, relation: "changed" }, context({ a: 1 }, { a: 1, b: 2 })).status).toBe("pass");
    let calls = 0;
    const unavailable: CausalPredicate = { scope, relation: "becomes", equals: { get count() { calls++; return 1; } } };
    expect(evaluateCausalPredicate(unavailable, context(0, 1)).status).toBe("inconclusive");
    expect(calls).toBe(0);
  });

  test("DOM presence is a relative scoped count rather than a reused already-present element", () => {
    const domScope: BaselineScope = { ...scope, kind: "element", target: "#success", path: undefined };
    const canonicalScope = { sessionId: domScope.sessionId, generation: domScope.generation, kind: "element" as const, target: "#success" };
    const dom = (beforeValue: number, afterValue: number): CausalPredicateContext => ({
      ...context(false, true),
      before: captureBaselineReading({ scope: canonicalScope, cursor: 100, complete: true, fresh: true }, beforeValue),
      after: captureBaselineReading({ scope: canonicalScope, cursor: 120, complete: true, fresh: true, actionId: "click-1" }, afterValue),
      attribution: captureCausalAttribution({ type: "action.result", t: 121, actionId: "click-1", data: { scope: canonicalScope, baselineCursor: 100, baselineValue: beforeValue, readingCursor: 120, value: afterValue } }),
    });
    const shown: CausalPredicate = { scope: canonicalScope, relation: "increased" };
    expect(evaluateCausalPredicate(shown, dom(0, 1)).status).toBe("pass");
    expect(evaluateCausalPredicate({ scope: canonicalScope, relation: "becomes", equals: 1 }, dom(1, 1)).status).toBe("inconclusive");
  });
});

describe("declared operation outcome attribution", () => {
  const operation = (phase: OperationReading["phase"], operationId = "save-1"): CausalPredicateContext => {
    const outcome = { operationId, phase };
    return context(false, true, {
      after: captureBaselineReading({ scope, cursor: 120, complete: true, fresh: true, actionId: "click-1", outcome }, true),
      attribution: captureCausalAttribution({ type: "operation.result", t: 121, actionId: "click-1", data: { ...baselineFields, scope, readingCursor: 120, value: true, ...outcome } }),
    });
  };

  test("202-style acceptance proves only its declared acceptance contract", () => {
    const accepted: CausalPredicate = { ...predicate, requiredOutcome: { operationId: "save-1", phase: "accepted" } };
    const final: CausalPredicate = { ...predicate, requiredOutcome: { operationId: "save-1", phase: "final" } };
    expect(evaluateCausalPredicate(accepted, operation("accepted")).status).toBe("pass");
    const pending = evaluateCausalPredicate(final, operation("accepted"));
    expect(pending.status).toBe("inconclusive");
    expect(pending.reason).toContain("final persistence has not been established");
    expect(evaluateCausalPredicate(final, operation("final")).status).toBe("pass");
    expect(evaluateCausalPredicate(accepted, operation("final")).status).toBe("inconclusive");
  });

  test("wrong operation identity, generic action acknowledgement or conflicting phase stays inconclusive", () => {
    const final: CausalPredicate = { ...predicate, requiredOutcome: { operationId: "save-1", phase: "final" } };
    expect(evaluateCausalPredicate(final, operation("final", "other-save")).status).toBe("inconclusive");
    expect(evaluateCausalPredicate(final, context(false, true)).status).toBe("inconclusive");
    const acceptedReading = captureBaselineReading({ scope, cursor: 120, complete: true, fresh: true, actionId: "click-1", outcome: { operationId: "save-1", phase: "accepted" } }, true);
    expect(evaluateCausalPredicate(final, { ...operation("final"), after: acceptedReading }).status).toBe("inconclusive");
    expect(evaluateCausalPredicate(predicate, { ...operation("final"), after: acceptedReading }).status).toBe("inconclusive");
  });

  test("persisted accepted results remain inspectable but deserialization does not recreate process-local proof", () => {
    const original = operation("accepted");
    const copied = JSON.parse(JSON.stringify(original.attribution)) as CausalAttribution;
    expect(copied).toMatchObject({ source: "declared-operation", actionId: "click-1", reading: {
      availability: "complete", value: true, outcome: { operationId: "save-1", phase: "accepted" },
    } });
    const accepted: CausalPredicate = { ...predicate, requiredOutcome: { operationId: "save-1", phase: "accepted" } };
    expect(evaluateCausalPredicate(accepted, { ...original, attribution: copied }).status).toBe("inconclusive");
  });

  test("ordinary interval events and partial, stale, accessor or incomplete result records cannot manufacture attribution", () => {
    const result = { type: "action.result", t: 121, actionId: "click-1", data: { ...baselineFields, scope, readingCursor: 120, value: true } };
    for (const invalid of [
      { ...result, type: "dom" }, { ...result, truncated: true }, { ...result, actionId: "" },
      { ...result, data: { ...baselineFields, scope, readingCursor: 122, value: true } },
      { ...result, data: { ...baselineFields, scope, readingCursor: 120 } },
      { ...result, data: { scope, readingCursor: 120, value: true } },
      { ...result, data: { ...result.data, value: "[REDACTED]" } },
      { ...result, data: { ...result.data, phase: "final", operationId: "save-1" } },
      { ...result, type: "operation.result", data: { ...result.data, phase: "pending", operationId: "save-1" } },
    ]) expect(() => captureCausalAttribution(invalid)).toThrow();
    let calls = 0;
    const malicious = Object.defineProperty({ ...result.data }, "value", { get() { calls++; return true; } });
    expect(() => captureCausalAttribution({ ...result, data: malicious })).toThrow();
    expect(calls).toBe(0);
  });
});
