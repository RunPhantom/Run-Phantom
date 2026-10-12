import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deriveCapturedAgentDefinitions, withholdAgentDefinitionCapture } from "../src/agent-definitions";
import { AGENT_DEFINITION_CAPTURE_KEY as KEY, AGENT_DEFINITION_LIMITS as L } from "../src/agent-definitions-protocol";
import { captureOtlpEvidence } from "../src/spans/otlp-evidence";
import { parseOtlpRequest } from "../src/parse";
import { definitionTrace } from "./fixtures/agent-definitions";
const base = () => ({ version: 1, systemPrompt: "  Exact\n🧪 instructions\r\n", tools: [{ name: "lookup", description: "Find an entry", parameters: { type: "object", properties: { query: { type: "string" } } } }], model: "captured-model", providers: ["local-fixture"], runtime: { temperature: .70001, top_p: .99, maxOutputTokens: 64 } });
function row(value: unknown = base(), id = "root") {
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  const source = { attributes: [{ key: KEY, value: { stringValue: payload } }] };
  return { id, attributes: JSON.stringify({ [KEY]: payload }), otlp_evidence: JSON.stringify(captureOtlpEvidence(source, {}, {})) };
}
function capture(value: unknown = base()) { return deriveCapturedAgentDefinitions([row(value)])!.records[0]; }
function digest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
describe("bounded captured agent definition identity", () => {
  test("hashes exact observed UTF8 prompt and retains complete explicit source provenance without raw configuration", () => {
    const result = capture(); expect(result.complete).toBe(true); expect(result.provenance).toBe("explicit-v1");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/); expect(result.components.prompt.sha256).toBe(digest(base().systemPrompt));
    const serialized = JSON.stringify(result); for (const raw of [base().systemPrompt, "Find an entry", "captured-model", "local-fixture"]) expect(serialized).not.toContain(raw);
  });
  test.each(["Exact\n🧪 instructions\r\n", "  Exact 🧪 instructions\r\n", "  Exact\n🧪 instructions\n", "  Exact\n🧪 instructions\r\n "])("prompt bytes remain distinct: %j", systemPrompt => {
    const result = capture({ ...base(), systemPrompt }); expect(result.components.prompt.sha256).toBe(digest(systemPrompt)); expect(result.sha256).not.toBe(capture().sha256);
  });
  test.each([
    { tools: [{ ...base().tools[0], description: "Different description" }] },
    { tools: [{ ...base().tools[0], parameters: { type: "object", properties: { query: { type: "number" } } } }] },
    { model: "other-model" }, { providers: ["other-provider"] },
    { runtime: { ...base().runtime, temperature: .70002 } },
    { runtime: { ...base().runtime, vendorSetting: "precise" } },
  ])("meaningful definition changes remain distinct: %j", change => expect(capture({ ...base(), ...change }).sha256).not.toBe(capture().sha256));
  test("tool and provider set order and object insertion order do not create versions; nested array order remains material", () => {
    const tools = [...base().tools, { name: "🧪", description: "Unicode", parameters: { enum: ["a", "b"] } }, { name: "\ue000", description: "Private-plane tool", parameters: {} }];
    const a = capture({ ...base(), providers: ["b", "a"], tools });
    const b = capture({ runtime: base().runtime, providers: ["a", "b"], tools: [...tools].reverse(), model: base().model, systemPrompt: base().systemPrompt, version: 1 });
    expect(a.sha256).toBe(b.sha256); expect(a.sha256).not.toBe(capture({ ...base(), providers: ["a", "b"], tools: [tools[0], { ...tools[1], parameters: { enum: ["b", "a"] } }, tools[2]] }).sha256);
  });
  test.each(["systemPrompt", "tools", "model", "providers", "runtime"])("missing explicit %s never becomes a complete version", field => {
    const value: Record<string, unknown> = base(); delete value[field]; const result = capture(value);
    expect(result.complete).toBe(false); expect(result.sha256).toBeNull(); expect(result.reasons).toContain("capture_partial");
  });
  test.each(['{"version":1,"systemPrompt":"a","systemPrompt":"b"}', '{"version":1,"runtime":{"a":1,"\\u0061":2}}', '{"version":1,"runtime":{"temperature":0.70001000000000001}}', '{"version":2}'])("duplicate/ambiguous/lossy/unknown definition stays unavailable: %s", raw => {
    const result = capture(raw); expect(result.complete).toBe(false); expect(result.sha256).toBeNull();
  });
  test("known secrets and unavailable placeholders are not declassified through prompt or semantic digests", () => {
    for (const systemPrompt of [`sk-proj-${"x".repeat(48)}`, "[REDACTED]", "[TRUNCATED]"]) {
      const result = capture({ ...base(), systemPrompt }); expect(result.complete).toBe(false); expect(result.sha256).toBeNull(); expect(result.components.prompt.sha256).toBeNull();
      expect(JSON.stringify(result)).not.toContain(systemPrompt);
    }
    const result = capture({ ...base(), runtime: { password: "private-value" } }); expect(result.sha256).toBeNull(); expect(JSON.stringify(result)).not.toContain("private-value");
  });
  test("actual shared redaction of underscore max_tokens never gets bypassed through flattened raw capture", () => {
    const result = capture({ ...base(), runtime: { temperature: .7, max_tokens: 64 } });
    expect(result.complete).toBe(false); expect(result.sha256).toBeNull(); expect(result.reasons).toContain("capture_redacted");
    expect(result.components.runtime.sha256).toBeNull(); expect(result.components.prompt.sha256).toBeNull();
  });
  test("typed duplicate attributes override flattened last-value evidence without falling back", () => {
    const r = row(), payload = JSON.stringify(base()); r.otlp_evidence = JSON.stringify(captureOtlpEvidence({ attributes: [{ key: KEY, value: { stringValue: payload } }, { key: KEY, value: { stringValue: payload } }] }, {}, {}));
    const result = deriveCapturedAgentDefinitions([r])!.records[0]; expect(result.complete).toBe(false); expect(result.sha256).toBeNull(); expect(result.reasons).toContain("capture_ambiguous");
  });
  test("explicit definitions from inherited resource attributes do not become authoritative span captures", () => {
    const r = row(); r.otlp_evidence = JSON.stringify(captureOtlpEvidence({ attributes: [] }, { resource: { attributes: [{ key: KEY, value: { stringValue: JSON.stringify(base()) } }] } }, {}));
    const result = deriveCapturedAgentDefinitions([r])!.records[0]; expect(result.complete).toBe(false); expect(result.sha256).toBeNull();
  });
  test("legacy instructions may retain safe exact prompt evidence but never infer complete configuration or invocation identity", () => {
    const r = { id: "legacy", attributes: JSON.stringify({ "gen_ai.system_instructions": "A\r\nB", "gen_ai.tool.definitions": "[]", "gen_ai.request.model": "fixture" }) };
    const result = deriveCapturedAgentDefinitions([r])!.records[0]; expect(result.provenance).toBe("legacy-attributes"); expect(result.components.prompt.sha256).toBe(digest("A\r\nB")); expect(result.complete).toBe(false); expect(result.sha256).toBeNull();
    expect(deriveCapturedAgentDefinitions([{ id: "query", attributes: JSON.stringify({ "runphantom.input": "A\r\nB", "ai.toolCall.name": "lookup" }) }])).toBeUndefined();
  });
  test("receipt absence and receiver loss keep explicitly captured hashes partial and never certify completeness", () => {
    const r = row(); delete (r as { otlp_evidence?: string }).otlp_evidence;
    expect(deriveCapturedAgentDefinitions([r])!.records[0].complete).toBe(false);
    const lost = row(); const typed = JSON.parse(lost.otlp_evidence); typed.capture.droppedAttributes = 1; lost.otlp_evidence = JSON.stringify(typed);
    expect(deriveCapturedAgentDefinitions([lost])!.records[0].sha256).toBeNull();
  });
  test.each(["resource", "scope", "events", "links"])("SDK-reported %s loss cannot certify an authoritative complete definition", source => {
    const r = row(), typed = JSON.parse(r.otlp_evidence);
    if (source === "resource") typed.resource = { attributes: [], schemaUrl: null, droppedAttributesCount: 1 };
    else if (source === "scope") typed.scope = { attributes: [], name: null, version: null, schemaUrl: null, droppedAttributesCount: 1 };
    else typed[source === "events" ? "droppedEventsCount" : "droppedLinksCount"] = 1;
    r.otlp_evidence = JSON.stringify(typed);
    const result = deriveCapturedAgentDefinitions([r])!.records[0]; expect(result.complete).toBe(false); expect(result.sha256).toBeNull(); expect(result.reasons).toContain("source_receipt_loss");
  });
  test("captured negative zero is refused rather than merged with a materially distinct finite runtime value", () => {
    const raw = JSON.stringify(base()).replace('"temperature":0.70001', '"temperature":-0'), result = capture(raw);
    expect(result.complete).toBe(false); expect(result.sha256).toBeNull(); expect(result.reasons).toContain("capture_invalid");
  });
  test.each(["\0", "\ud800"])("invalid source identity %j remains unavailable without a complete version", id => {
    const record = deriveCapturedAgentDefinitions([row(base(), id)])!.records[0];
    expect(record.sourceSpanId).toBeNull(); expect(record.sha256).toBeNull(); expect(record.reasons).toContain("source_identity_unavailable");
  });
  test("public projection retains ordered collisions and unrelated evidence, counts actual withholding once, and cannot complete after transfer", () => {
    const r = row(); const evidence = JSON.parse(r.otlp_evidence);
    const definition = evidence.attributes[0];
    evidence.resource = { attributes: [structuredClone(definition)], schemaUrl: null, droppedAttributesCount: null };
    evidence.scope = { attributes: [structuredClone(definition)], name: "fixture", version: null, schemaUrl: null, droppedAttributesCount: null };
    evidence.attributes.push(structuredClone(definition), { key: "ordinary", value: { intValue: "9007199254740993" } });
    r.otlp_evidence = JSON.stringify(evidence);
    const projected = withholdAgentDefinitionCapture(r), typed = JSON.parse(projected.otlp_evidence);
    expect(typed.capture.redactedValues).toBe(4); expect(typed.attributes[2]).toEqual(evidence.attributes[2]);
    expect(typed.attributes.map((a: any) => a.key)).toEqual(evidence.attributes.map((a: any) => a.key));
    expect(JSON.stringify(projected)).not.toContain("Find an entry"); expect(r.otlp_evidence).toContain("Find an entry");
    expect(withholdAgentDefinitionCapture(projected)).toBe(projected);
    const imported = deriveCapturedAgentDefinitions([projected])!.records[0]; expect(imported.complete).toBe(false); expect(imported.sha256).toBeNull(); expect(imported.reasons).toContain("capture_redacted");
  });
  test("escaped capture keys cannot bypass projection and redaction count overflow refuses instead of inventing source counts", () => {
    const r = row(); r.attributes = r.attributes.replace("runphantom", "\\u0072unphantom");
    expect(JSON.parse(withholdAgentDefinitionCapture(r).attributes)[KEY]).toBe("[REDACTED]");
    const typed = JSON.parse(r.otlp_evidence); typed.capture.redactedValues = 0xffffffff; r.otlp_evidence = JSON.stringify(typed);
    expect(() => withholdAgentDefinitionCapture(r)).toThrow("Public definition capture is unavailable");
  });
  test("public projection preserves byte-identical unrelated attributes and receipts and withholds nested ordered definition values", () => {
    const fixture = definitionTrace(97);
    fixture.body.resourceSpans[0].scopeSpans[0].spans[0].attributes = [
      { key: "ordinary", value: { stringValue: "unchanged" } },
      { key: "private.carrier", value: { kvlistValue: { values: [{ key: KEY, value: { stringValue: "private nested definition" } }] } } } as any,
    ];
    const actual = parseOtlpRequest(fixture.body)[0];
    const projected = withholdAgentDefinitionCapture({ attributes: '{ "ordinary" : "unchanged" }', otlp_evidence: JSON.stringify(actual.otlpEvidence) });
    expect(projected.attributes).toBe('{ "ordinary" : "unchanged" }'); expect(projected.otlp_evidence).not.toContain("private nested definition");
    const companion = withholdAgentDefinitionCapture({ attributes: JSON.stringify(actual.attributes), otlp_evidence: JSON.stringify(actual.otlpEvidence) });
    expect(JSON.parse(companion.attributes).ordinary).toBe("unchanged");
    expect(JSON.parse(JSON.parse(companion.attributes)["private.carrier"])[KEY]).toBe("[REDACTED]");
    expect(actual.attributes["private.carrier"]).toContain("private nested definition");
    const unrelated = { attributes: '{ "ordinary" : "unchanged" }', otlp_evidence: JSON.stringify(captureOtlpEvidence({ attributes: [{ key: "ordinary", value: { stringValue: "safe" } }] }, {}, {})) };
    expect(withholdAgentDefinitionCapture(unrelated)).toBe(unrelated);
    for (const attributes of ['opaque C:\\fixture\\record', '"runphantom.agent.definition is a literal value"', '{"ordinary":"\\u0053afe"}']) {
      const legacy = { attributes }; expect(withholdAgentDefinitionCapture(legacy)).toBe(legacy);
    }
  });
  test("the original same-key mismatched private composite is unavailable rather than ordinary source evidence", () => {
    const receipt = captureOtlpEvidence({ attributes: [{ key: "ordinary", value: { kvlistValue: { values: [{ key: KEY, value: { stringValue: "private nested definition" } }] } } }] }, {}, {});
    const source = { attributes: '{ "ordinary" : "unchanged" }', otlp_evidence: JSON.stringify(receipt) };
    const projected = withholdAgentDefinitionCapture(source);
    expect(JSON.parse(projected.attributes).ordinary).toBe("[UNAVAILABLE]");
    expect(projected.otlp_evidence).not.toContain("private nested definition");
    expect(source.attributes).toBe('{ "ordinary" : "unchanged" }'); expect(source.otlp_evidence).toContain("private nested definition");
  });
  test("duplicate tool names, unknown capture fields, and over-limit definitions do not silently drop evidence", () => {
    for (const change of [{ tools: [base().tools[0], base().tools[0]] }, { tools: [{ ...base().tools[0], parameters: null }] }, { unknown: "not-in-contract" }, { tools: Array.from({ length: L.tools + 1 }, (_, i) => ({ name: `tool-${i}` })) }, { systemPrompt: "x".repeat(L.fieldBytes + 1) }]) {
      const result = capture({ ...base(), ...change }); expect(result.complete).toBe(false); expect(result.sha256).toBeNull();
    }
  });
  test("record bounds disclose omitted observations while equal prompt hashes retain distinct source spans", () => {
    const result = deriveCapturedAgentDefinitions(Array.from({ length: L.records + 3 }, (_, i) => row(base(), `root-${i}`)))!;
    expect(result.observedRecords).toBe(L.records + 3); expect(result.omittedRecords).toBeGreaterThanOrEqual(3); expect(result.complete).toBe(false);
    expect(new Set(result.records.map(r => r.sourceSpanId)).size).toBe(result.records.length);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(L.metadataBytes);
  });
});
