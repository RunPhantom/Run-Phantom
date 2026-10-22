import { expect, test } from "bun:test";
import { withholdAgentDefinitionCapture } from "../src/agent-definitions";
import { validateOtlpEvidence, type OtlpEvidence } from "../src/spans/otlp-evidence";
import { definitionKey } from "./fixtures/agent-definitions";
import { duplicateDefinitionReceipt, ordinaryDefinitionReceipt, receiptSources } from "./fixtures/agent-definition-receipts";

for (const source of receiptSources) for (const privateFirst of [true, false]) for (const escaped of [false, true]) {
  test(`public receipt refuses ${source} lexical duplicates (${privateFirst ? "private-first" : "private-last"}, ${escaped ? "escaped-alias" : "plain"}) without mutating source`, () => {
    const original = ordinaryDefinitionReceipt(9910).source;
    const raw = duplicateDefinitionReceipt(original.otlp_evidence, source, privateFirst, escaped, "Private ambiguous receipt instruction");
    validateOtlpEvidence(JSON.parse(raw));
    const input = Object.freeze({ ...original, otlp_evidence: raw });
    const before = JSON.stringify(input);
    expect(() => withholdAgentDefinitionCapture(input)).toThrow("Public definition capture is unavailable");
    expect(JSON.stringify(input)).toBe(before);
  });
}

test("lexical-looking business strings remain exact inside a genuine nonduplicate receipt", () => {
  const original = ordinaryDefinitionReceipt(9911).source, receipt = JSON.parse(original.otlp_evidence) as OtlpEvidence;
  const business = `{"${definitionKey}":"First business value","${definitionKey}":"Last business value"}`;
  receipt.attributes.push({ key: "ordinary.literal", value: { stringValue: business } });
  const source = Object.freeze({ ...original, attributes: JSON.stringify({ ...JSON.parse(original.attributes), "ordinary.literal": business }),
    otlp_evidence: JSON.stringify(receipt) });
  expect(withholdAgentDefinitionCapture(source)).toBe(source);
  expect(JSON.parse(source.otlp_evidence).attributes.at(-1).value.stringValue).toBe(business);
});

test("ordered duplicate attribute-array entries remain legal, private values withheld in order and original business bytes exact", () => {
  const original = ordinaryDefinitionReceipt(9912).source, receipt = JSON.parse(original.otlp_evidence) as OtlpEvidence;
  const baseline = structuredClone(receipt);
  receipt.attributes.push({ key: definitionKey, value: { stringValue: "Private first ordered capture" } },
    { key: definitionKey, value: { stringValue: "Private second ordered capture" } });
  const source = Object.freeze({ ...original, otlp_evidence: JSON.stringify(receipt) });
  const projected = withholdAgentDefinitionCapture(source), observed = JSON.parse(projected.otlp_evidence) as OtlpEvidence;
  expect(observed.attributes.slice(0, baseline.attributes.length)).toEqual(baseline.attributes);
  expect(observed.attributes.slice(-2)).toEqual([{ key: definitionKey, value: { stringValue: "[REDACTED]" } },
    { key: definitionKey, value: { stringValue: "[REDACTED]" } }]);
  expect(observed.capture.redactedValues).toBe(2);
  expect(projected.attributes).toBe(original.attributes); expect(projected.input_payload).toBe(original.input_payload);
  expect(projected.output_payload).toBe(original.output_payload); expect(source.otlp_evidence).toContain("Private first ordered capture");
  expect(withholdAgentDefinitionCapture(projected)).toBe(projected);
});
