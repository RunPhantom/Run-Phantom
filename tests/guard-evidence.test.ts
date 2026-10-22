import { expect, test } from "bun:test";
import { deriveCapturedGuardEvidence, projectCapturedGuardSpan } from "../src/guard-evidence";
import { GUARD_EVIDENCE_LIMITS } from "../src/guard-evidence-protocol";
import { parseOtlpRequest } from "../src/parse";
import { guardEvent, guardHarmless, guardRequest, guardSecrets } from "./fixtures/guard-evidence";

const receipt = (body = guardRequest()) => JSON.stringify(parseOtlpRequest(body)[0].otlpEvidence);
test("reported actions preserve source time, zero and false without claiming verified execution", () => {
  const captured = deriveCapturedGuardEvidence(receipt());
  expect(captured).toMatchObject({ advisory: true, execution: "unknown", state: "partial",
    counts: { capturedDecisions: 5, visibleDecisions: 5, omittedDecisions: 0, exporterDroppedEvents: 0 } });
  expect(captured.decisions.map(d => d.action)).toEqual(["allow", "warn", "redact", "deny", "allow"]);
  expect(captured.decisions[0]).toMatchObject({ receiptEventIndex: 0, sourceEventIndex: 0, timeUnixNano: "1770000000000000002", score: 0, latencyMs: 0, error: false, state: "reported" });
  expect(captured.decisions[4]).toMatchObject({ error: true, state: "partial", reasons: ["producer_error"] });
  expect(JSON.stringify(captured)).not.toMatch(/"(?:verified|passed|clean|complete)"/);
});

test("duplicates, missing fields and invalid enums/numbers are counted instead of using defaults", () => {
  const body = guardRequest() as any, event = guardEvent("pass", { "guard.phase": "request", "guard.score": -1, "guard.latency_ms": -1 });
  event.attributes = event.attributes.filter(a => a.key !== "guard.name");
  event.attributes.push({ key: "guard.action", value: { stringValue: "deny" } });
  body.resourceSpans[0].scopeSpans[0].spans[0].events = [event];
  const captured = deriveCapturedGuardEvidence(receipt(body)), decision = captured.decisions[0];
  expect(decision).toMatchObject({ action: "unknown", phase: "unknown", name: null, score: null, latencyMs: null, state: "unknown" });
  expect(captured.counts).toMatchObject({ duplicateFields: 1, missingFields: 1, invalidEnumFields: 1, invalidNumericFields: 2 });
  expect(decision.fieldIssues).toContainEqual({ field: "guard.action", reason: "field_duplicate" });
});

test("exporter and receiver losses stay independent and event positions become unknown when omissions obscure them", () => {
  const body = guardRequest() as any, span = body.resourceSpans[0].scopeSpans[0].spans[0];
  span.events = [{ name: "", attributes: [] }, guardEvent()]; span.droppedEventsCount = 7;
  delete span.events[1].droppedAttributesCount;
  const captured = deriveCapturedGuardEvidence(receipt(body));
  expect(captured).toMatchObject({ state: "partial", counts: { exporterDroppedEvents: 7, receiverDroppedEvents: 1 } });
  expect(captured.reasons).toEqual(expect.arrayContaining(["exporter_events_dropped", "receiver_events_dropped", "exporter_attributes_unknown"]));
  expect(captured.decisions[0]).toMatchObject({ receiptEventIndex: 0, sourceEventIndex: null });
  expect(captured.decisions[0].reasons).toContain("source_index_unknown");
  delete span.droppedEventsCount;
  expect(deriveCapturedGuardEvidence(receipt(body)).counts.exporterDroppedEvents).toBeNull();
  expect(deriveCapturedGuardEvidence(receipt(body)).reasons).toContain("exporter_loss_unknown");
});

test("visible decisions and UTF-8 text/public bytes are bounded with explicit whole-item loss", () => {
  const body = guardRequest() as any, span = body.resourceSpans[0].scopeSpans[0].spans[0];
  span.events = Array.from({ length: 129 }, () => guardEvent("warn"));
  const cappedEvents = deriveCapturedGuardEvidence(receipt(body));
  expect(cappedEvents.counts.capturedDecisions).toBe(128); expect(cappedEvents.counts.receiverDroppedEvents).toBe(1);
  expect(cappedEvents.decisions).toHaveLength(32); expect(cappedEvents.counts.omittedDecisions).toBe(96);
  span.events = Array.from({ length: 33 }, () => guardEvent("warn", { "guard.name": "🧪".repeat(60), "guard.classification": "分類".repeat(100), "guard.explanation": "🧪".repeat(900) }));
  const captured = deriveCapturedGuardEvidence(receipt(body));
  expect(captured.decisions.length).toBeLessThanOrEqual(32);
  expect(captured.counts.capturedDecisions).toBe(33); expect(captured.counts.receiverDroppedEvents).toBe(0);
  expect(captured.counts.omittedDecisions).toBe(33 - captured.decisions.length);
  expect(Buffer.byteLength(JSON.stringify(captured))).toBeLessThanOrEqual(GUARD_EVIDENCE_LIMITS.publicBytes);
  expect(captured.decisions[0].fieldIssues).toHaveLength(3);
  expect(Buffer.byteLength(captured.decisions[0].name!)).toBeLessThanOrEqual(128);
  expect(Buffer.byteLength(captured.decisions[0].classification!)).toBeLessThanOrEqual(256);
  expect(Buffer.byteLength(captured.decisions[0].explanation!)).toBeLessThanOrEqual(2048);
});

test("missing, malformed, oversized and duplicate-key receipts never accept cached decision authority", () => {
  for (const raw of [null, "{", " ".repeat(GUARD_EVIDENCE_LIMITS.receiptBytes + 1), receipt().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')]) {
    const span = projectCapturedGuardSpan({ id: "fixture", status: "ERROR", output_payload: "unchanged", otlp_evidence: raw,
      guardEvidence: { decisions: [{ action: "allow", explanation: guardSecrets.password }] }, guard_decisions: guardSecrets.npm, hidden: guardSecrets.hf });
    expect(span.guardEvidence.execution).toBe("unknown"); expect(span.guardEvidence.decisions).toEqual([]);
    expect(span).toMatchObject({ status: "ERROR", output_payload: "unchanged" });
    expect(JSON.stringify(span)).not.toContain(guardSecrets.password); expect(JSON.stringify(span)).not.toContain(guardSecrets.npm); expect(JSON.stringify(span)).not.toContain(guardSecrets.hf);
    if (raw !== null) expect(span.otlp_evidence).toBeNull();
  }
  let invoked = false;
  const accessor = Object.defineProperty({}, "otlp_evidence", { enumerable: true, get() { invoked = true; throw Error("never"); } });
  expect(deriveCapturedGuardEvidence(accessor).decisions).toEqual([]); expect(invoked).toBe(false);
});

test("inert producer explanation is preserved while default credential markers remain partial evidence", () => {
  const body = guardRequest() as any; body.resourceSpans[0].scopeSpans[0].spans[0].events = [guardEvent("deny", {
    "guard.explanation": `<script>throw new Error('inert')</script> ${guardSecrets.npm} ${guardSecrets.hf} ${guardSecrets.pem} ${guardHarmless}` })];
  const captured = deriveCapturedGuardEvidence(receipt(body)), serialized = JSON.stringify(captured);
  for (const secret of [guardSecrets.npm, guardSecrets.hf, guardSecrets.pem]) expect(serialized).not.toContain(secret);
  expect(captured.decisions[0].explanation).toContain("<script>"); expect(captured.decisions[0].explanation).toContain(guardHarmless);
  expect(captured.decisions[0].fieldIssues).toContainEqual({ field: "guard.explanation", reason: "capture_redacted" });
});
