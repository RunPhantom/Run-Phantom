import { describe, expect, test } from "bun:test";
import { withholdAgentDefinitionCapture } from "../src/agent-definitions";
import { AGENT_DEFINITION_CAPTURE_KEY as KEY } from "../src/agent-definitions-protocol";
import { parseOtlpRequest } from "../src/parse";
import { definitionTrace } from "./fixtures/agent-definitions";

const privateValue = "Private nested definition retained only in source";
const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
const composite = () => ({ kvlistValue: { values: [text("ordinary.sibling", "Business value unchanged"), text(KEY, privateValue)] } });
function captured(value: unknown = composite()) {
  const capture = definitionTrace(92);
  capture.body.resourceSpans[0].scopeSpans[0].spans[0].attributes.push({ key: "ordinary.envelope", value } as any);
  const span = parseOtlpRequest(capture.body)[0];
  return { attributes: JSON.stringify(span.attributes), otlp_evidence: JSON.stringify(span.otlpEvidence) };
}
function flat(row: { attributes: string }) { return JSON.parse(row.attributes); }

describe("source-authoritative public nested definition projection", () => {
  test("actual kvlist carrier projects the private value and preserves siblings, source and idempotent counts", () => {
    const source = captured(), projected = withholdAgentDefinitionCapture(source);
    const envelope = JSON.parse(flat(projected)["ordinary.envelope"]);
    expect(envelope[KEY]).toBe("[REDACTED]"); expect(envelope["ordinary.sibling"]).toBe("Business value unchanged");
    expect(JSON.stringify(projected)).not.toContain(privateValue); expect(source.attributes).toContain(privateValue);
    expect(source.otlp_evidence).toContain(privateValue); expect(JSON.parse(projected.otlp_evidence).capture.redactedValues).toBe(2);
    expect(withholdAgentDefinitionCapture(projected)).toBe(projected);
  });
  test("actual array/kvlist structure retains material ordering and genuine JSON-looking stringValue siblings exactly", () => {
    const business = JSON.stringify({ [KEY]: "literal business text, not a typed definition capture" });
    const source = captured({ arrayValue: { values: [{ stringValue: business }, composite(), { boolValue: false }, { intValue: "7" }] } });
    const projected = withholdAgentDefinitionCapture(source), envelope = JSON.parse(flat(projected)["ordinary.envelope"]);
    expect(envelope).toEqual([business, { "ordinary.sibling": "Business value unchanged", [KEY]: "[REDACTED]" }, false, 7]);
    expect(JSON.parse(projected.otlp_evidence).attributes.at(-1).value.arrayValue.values[0]).toEqual({ stringValue: business });
  });
  test("genuine scalar JSON-looking business strings never become recursively decoded definition captures", () => {
    const business = JSON.stringify({ [KEY]: "This is an ordinary typed string" });
    const source = captured({ stringValue: business });
    expect(flat(withholdAgentDefinitionCapture(source))["ordinary.envelope"]).toBe(business);
  });
  test.each(["missing", "loss", "alias", "duplicate", "mismatch"])("unknown %s composite correspondence withholds the carrier without dropping other business attributes", problem => {
    const source: { attributes: string; otlp_evidence?: string } = captured();
    const receipt = JSON.parse(source.otlp_evidence!);
    if (problem === "missing") delete source.otlp_evidence;
    if (problem === "loss") receipt.capture.droppedAttributes = 1;
    if (problem === "alias") receipt.resource.attributes.push(structuredClone(receipt.attributes.at(-1)));
    if (problem === "duplicate") receipt.attributes.at(-1).value.kvlistValue.values.push(text(KEY, "Second private nested definition"));
    if (problem === "mismatch") receipt.attributes.at(-1).value.kvlistValue.values[0].value.stringValue = "Different source sibling";
    if (problem !== "missing") source.otlp_evidence = JSON.stringify(receipt);
    const projected = withholdAgentDefinitionCapture(source), attributes = flat(projected);
    expect(attributes["ordinary.envelope"]).toBe("[UNAVAILABLE]"); expect(attributes["ordinary.span"]).toBe("span unchanged");
    expect(JSON.stringify(projected)).not.toContain(privateValue);
  });
  test("malformed relevant typed source refuses a public projection instead of trusting a guessed flat companion", () => {
    const source = captured(); source.otlp_evidence = source.otlp_evidence.slice(0, -1);
    expect(() => withholdAgentDefinitionCapture(source)).toThrow("Public definition capture is unavailable");
  });
  test("exact-key projection leaves similarly named business keys and their values intact", () => {
    const source = captured({ kvlistValue: { values: [text(KEY + ".suffix", "Business alias unchanged"), text(KEY, privateValue)] } });
    const envelope = JSON.parse(flat(withholdAgentDefinitionCapture(source))["ordinary.envelope"]);
    expect(envelope[KEY + ".suffix"]).toBe("Business alias unchanged"); expect(envelope[KEY]).toBe("[REDACTED]");
  });
});


function withoutDirectDefinition(source = captured()) {
  const attributes = flat(source), receipt = JSON.parse(source.otlp_evidence);
  delete attributes[KEY]; receipt.attributes = receipt.attributes.filter((entry: { key: string }) => entry.key !== KEY);
  return { attributes: JSON.stringify(attributes), otlp_evidence: JSON.stringify(receipt) };
}

describe("escaped source-authoritative private carrier admission", () => {
  test.each(["\\u0072\\u0075nphantom.agent.definition", [...KEY].map(char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("")])("escaped key spelling %s cannot bypass exact source correspondence", spelling => {
    const source = withoutDirectDefinition(), attributes = flat(source);
    attributes["ordinary.envelope"] = attributes["ordinary.envelope"].replace(KEY, spelling);
    expect(JSON.parse(attributes["ordinary.envelope"])[KEY]).toBe(privateValue);
    source.attributes = JSON.stringify(attributes); const original = structuredClone(source);
    const projected = withholdAgentDefinitionCapture(source);
    expect(flat(projected)["ordinary.envelope"]).toBe("[UNAVAILABLE]"); expect(flat(projected)["ordinary.span"]).toBe("span unchanged");
    expect(JSON.stringify(projected)).not.toContain(privateValue); expect(source).toEqual(original);
    expect(JSON.parse(projected.otlp_evidence).capture.redactedValues).toBe(1); expect(withholdAgentDefinitionCapture(projected)).toBe(projected);
  });
  test("validated semantic source carrier forces admission even when the flat value has no reserved key text", () => {
    const source = withoutDirectDefinition(), attributes = flat(source);
    attributes["ordinary.envelope"] = "Changed lexical carrier " + privateValue; source.attributes = JSON.stringify(attributes);
    expect(flat(withholdAgentDefinitionCapture(source))["ordinary.envelope"]).toBe("[UNAVAILABLE]");
  });
  test("outer escaped carrier names retain exact typed-source correspondence and unrelated Unicode values", () => {
    const source = withoutDirectDefinition(); source.attributes = source.attributes.replace('"ordinary.envelope"', '"\\u006frdinary.envelope"');
    const projected = withholdAgentDefinitionCapture(source), envelope = JSON.parse(flat(projected)["ordinary.envelope"]);
    expect(envelope).toEqual({ "ordinary.sibling": "Business value unchanged", [KEY]: "[REDACTED]" });
  });
  test("a genuine matching escaped JSON-looking typed string remains exact without business JSON interpretation", () => {
    const business = JSON.stringify({ [KEY]: "Ordinary Unicode business é 🦊" }).replace(KEY, "\\u0072\\u0075nphantom.agent.definition");
    const source = withoutDirectDefinition(captured({ stringValue: business }));
    expect(withholdAgentDefinitionCapture(source)).toBe(source); expect(flat(source)["ordinary.envelope"]).toBe(business);
  });
  test("escaped nested arrays retain their safe unrelated source fields while lexical mismatch remains unavailable", () => {
    const source = withoutDirectDefinition(captured({ arrayValue: { values: [{ stringValue: "Safe material first" }, composite()] } })), attributes = flat(source);
    attributes["ordinary.envelope"] = attributes["ordinary.envelope"].replace(KEY, "\\u0072\\u0075nphantom.agent.definition"); source.attributes = JSON.stringify(attributes);
    expect(flat(withholdAgentDefinitionCapture(source))["ordinary.envelope"]).toBe("[UNAVAILABLE]"); expect(flat(withholdAgentDefinitionCapture(source))["ordinary.resource"]).toBe("resource unchanged");
  });
});
