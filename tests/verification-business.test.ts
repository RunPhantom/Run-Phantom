import { test, expect } from "bun:test";
import { parseBrowserMessage, parsePredicate } from "../src/verification/validation";
import { evaluatePredicate } from "../src/verification/predicates";
import type { Predicate, RuntimeEvent } from "../src/verification/protocol";
const coverage = { network: true, console: true, state: true, dom: true, signal: true, route: true };
const contract = { kind: "business-response", urlContains: "/order", method: "POST", operationId: "order-21", operationPath: "operationId", path: "result", equals: "paid", phase: "response" };
function event(type: string, data: Record<string, unknown>, t: number): RuntimeEvent { return { type, data, t, actionId: "action-21" }; }
function context(body: unknown, extra: RuntimeEvent[] = []) {
  return { capabilities: ["business-response-evidence"] as any, coverage, complete: true, settled: true, actionId: "action-21", events: [
    event("network.start", { requestId: "n1", url: "http://localhost/order", method: "POST", initiator: "fetch" }, 1),
    event("network", { requestId: "n1", url: "http://localhost/order", method: "POST", initiator: "fetch", status: 200, ok: true, durationMs: 1 }, 2),
    event("network.body", { requestId: "n1", source: "sdk-reported", state: "pending", format: "json", bytes: 0, chunks: 0 }, 3),
    event("network.body", { requestId: "n1", source: "sdk-reported", state: "complete", format: "json", bytes: 60, chunks: 1, body }, 4), ...extra ] };
}
test("explicit business operation contract is accepted independently of legacy network checks", () => {
  expect(parsePredicate(contract)).toEqual(contract);
  expect(parsePredicate({ kind: "network", urlContains: "/order", status: 200 })).toEqual({ kind: "network", urlContains: "/order", status: 200 });
});
test("body capture requires version4 capability and older hello remains strict", () => {
  expect(parseBrowserMessage({ type: "hello", version: 4, token: "local", coverage, capabilities: ["business-response-evidence"] })).toMatchObject({ version: 4 });
  expect(() => parseBrowserMessage({ type: "hello", version: 3, token: "local", coverage, capabilities: ["business-response-evidence"] })).toThrow();
});
test("complete same-operation response meets only a declared response contract", () => {
  const predicate = parsePredicate(contract);
  const result = evaluatePredicate(predicate, context({ operationId: "order-21", result: "paid" }));
  expect(result.status).toBe("pass");
  expect(result.reason).toContain("SDK");
  expect(evaluatePredicate({ ...predicate, phase: "final" } as Predicate, context({ operationId: "order-21", result: "paid" })).status).toBe("inconclusive");
});
test("same-operation declared witness disagreement fails and absent witness cannot agree", () => {
  const predicate = parsePredicate({ ...contract, witness: { kind: "state", store: "orders", operationPath: "operationId", path: "result" } });
  expect(evaluatePredicate(predicate, context({ operationId: "order-21", result: "paid" }, [event("state", { store: "orders", value: { operationId: "order-21", result: "rejected" } }, 5)])).status).toBe("fail");
  expect(evaluatePredicate(predicate, context({ operationId: "order-21", result: "paid" })).status).toBe("inconclusive");
});

import { bodyFailureFindings } from "../src/verification/business-evidence";
test("body conventions stay advisory and empty error values are not failures", () => {
  for (const value of [{}, [], false, 0, "", null]) expect(bodyFailureFindings({ errors: value, error: value })).toEqual([]);
  expect(bodyFailureFindings({ errors: [{ message: "declared failure" }] })).toEqual([{ path: "errors", reason: "Nonempty declared error field" }]);
  expect(bodyFailureFindings([{ ok: true }, { success: false }])).toEqual([{ path: "1.success", reason: "False success field" }]);
  const predicate = parsePredicate(contract);
  expect(evaluatePredicate(predicate, context({ operationId: "order-21", result: "paid", errors: ["unrelated advisory"] })).status).toBe("pass");
});
test("all unknown lifecycle states, redaction, capture loss and mismatched operation identities remain inconclusive", () => {
  const predicate = parsePredicate(contract);
  for (const state of ["pending", "truncated", "timeout", "aborted", "opaque", "unsupported", "unavailable"]) {
    const c = context({ operationId: "order-21", result: "paid" });
    c.events[3].data = { ...c.events[3].data, state };
    delete c.events[3].data.body;
    expect(evaluatePredicate(predicate, c).status).toBe("inconclusive");
  }
  for (const flag of ["redacted", "truncated"]) {
    const c = context({ operationId: "order-21", result: "paid" });
    if (flag === "redacted") c.events[3].data.redacted = true; else c.events[3].truncated = true;
    expect(evaluatePredicate(predicate, c).status).toBe("inconclusive");
  }
  expect(evaluatePredicate(predicate, { ...context({ operationId: "order-21", result: "paid" }), complete: false }).status).toBe("inconclusive");
  expect(evaluatePredicate(predicate, context({ operationId: "other-order", result: "paid" })).status).toBe("inconclusive");
  expect(evaluatePredicate(predicate, { ...context({ operationId: "order-21", result: "paid" }), capabilities: [] }).status).toBe("inconclusive");
  const c = context({ operationId: "order-21", result: "paid" }); c.events[0].actionId = "old-action";
  expect(evaluatePredicate(predicate, c).status).toBe("inconclusive");
});
test("missing, null, false and zero response values remain distinct", () => {
  for (const value of [null, false, 0]) {
    const predicate = parsePredicate({ ...contract, equals: value });
    expect(evaluatePredicate(predicate, context({ operationId: "order-21", result: value })).status).toBe("pass");
    expect(evaluatePredicate(predicate, context({ operationId: "order-21" })).status).toBe("inconclusive");
    expect(evaluatePredicate(predicate, context({ operationId: "order-21", result: "0" })).status).toBe("fail");
  }
});
test("acceptance202 is bounded separately from final persistence and declared signal disagreement", () => {
  const c = context({ operationId: "order-21", result: "paid" }); c.events[1].data.status = 202;
  expect(evaluatePredicate(parsePredicate({ ...contract, phase: "acceptance" }), c).status).toBe("pass");
  expect(evaluatePredicate(parsePredicate({ ...contract, phase: "final" }), c).status).toBe("inconclusive");
  const p = parsePredicate({ ...contract, witness: { kind: "signal", name: "rendered.order", operationPath: "operationId", path: "result" } });
  expect(evaluatePredicate(p, context({ operationId: "order-21", result: "paid" }, [event("signal", { name: "rendered.order", data: { operationId: "order-21", result: "rejected" } }, 5)])).status).toBe("fail");
  expect(evaluatePredicate(p, context({ operationId: "order-21", result: "paid" }, [event("signal", { name: "rendered.order", data: { operationId: "another", result: "paid" } }, 5)])).status).toBe("inconclusive");
});
test("strict body envelope refuses partial content and impossible completion", () => {
  const base = { requestId: "n1", source: "sdk-reported", state: "complete", format: "json", bytes: 20, chunks: 1, body: { operationId: "o" } };
  const message = (data: unknown) => ({ type: "event", event: { type: "network.body", data } });
  expect(parseBrowserMessage(message(base))).toMatchObject({ type: "event" });
  for (const invalid of [{ ...base, state: "timeout" }, { ...base, bytes: 32769 }, { ...base, chunks: 129 }, { ...base, format: "none" }, { ...base, source: "server-authenticated" }, { ...base, status: 200 }, { ...base, state: "pending" }]) expect(() => parseBrowserMessage(message(invalid))).toThrow();
  expect(() => parsePredicate({ ...contract, path: "password" })).toThrow();
  expect(() => parsePredicate({ ...contract, operationPath: "__proto__.id" })).toThrow();
});
