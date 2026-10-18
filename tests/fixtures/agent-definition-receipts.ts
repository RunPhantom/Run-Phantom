import { parseOtlpRequest } from "../../src/parse";
import type { EvidenceAttribute, OtlpEvidence } from "../../src/spans/otlp-evidence";
import { definitionTrace, definitionKey, definitionInput, definitionOutput } from "./agent-definitions";

export const receiptSources = ["span", "resource", "scope", "event", "link", "capture", "value"] as const;
export type ReceiptSource = typeof receiptSources[number];

export function ordinaryDefinitionReceipt(slot: number) {
  const capture = definitionTrace(slot);
  const span = capture.body.resourceSpans[0].scopeSpans[0].spans[0];
  span.attributes = span.attributes.filter(entry => entry.key !== definitionKey);
  const observed = parseOtlpRequest(capture.body)[0];
  return { capture, source: { attributes: JSON.stringify(observed.attributes), otlp_evidence: JSON.stringify(observed.otlpEvidence),
    input_payload: definitionInput, output_payload: definitionOutput } };
}

/** Valid last-member JSON semantics conceal lexical object-member ambiguity. */
export function duplicateDefinitionReceipt(raw: string, source: ReceiptSource, privateFirst: boolean, escaped: boolean, marker: string): string {
  const receipt = JSON.parse(raw) as OtlpEvidence;
  const privateEntries: EvidenceAttribute[] = [{ key: definitionKey, value: { stringValue: marker } }];
  let target: object, field: string, privateValue: unknown, safeValue: unknown;
  if (source === "capture") {
    receipt.attributes.push(...privateEntries); target = receipt.capture; field = "redactedValues"; privateValue = 1; safeValue = 0;
  } else if (source === "value") {
    const value = { stringValue: "Safe original receipt value" };
    receipt.attributes.push({ key: definitionKey, value }); target = value; field = "stringValue"; privateValue = marker; safeValue = "Safe duplicate value";
  } else {
    const owner = source === "span" ? receipt : source === "resource" ? receipt.resource : source === "scope" ? receipt.scope
      : source === "event" ? receipt.events[0] : receipt.links[0];
    if (!owner) throw new Error("Missing actual receipt fixture source");
    target = owner; field = "attributes"; privateValue = privateEntries; safeValue = owner.attributes;
  }
  const name = JSON.stringify(field), alias = escaped ? '"\\u' + field.charCodeAt(0).toString(16).padStart(4, "0") + field.slice(1) + '"' : name;
  const original = JSON.stringify(target), originalField = `${name}:${JSON.stringify((target as Record<string, unknown>)[field])}`;
  const values = privateFirst ? [privateValue, safeValue] : [safeValue, privateValue];
  const duplicate = original.replace(originalField, `${name}:${JSON.stringify(values[0])},${alias}:${JSON.stringify(values[1])}`);
  if (duplicate === original) throw new Error("Actual receipt fixture field was not replaced");
  return JSON.stringify(receipt).replace(original, duplicate);
}
