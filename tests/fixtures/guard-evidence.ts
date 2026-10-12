import { fidelityRequest } from "./otlp-evidence";

// Synthetic credential-shaped controls; none can authenticate with a provider.
export const guardSecrets = {
  npm: `npm_${"A1".repeat(24)}_tail`, hf: `hf_${"B2".repeat(24)}-tail`,
  pem: `-----BEGIN RSA PRIVATE KEY-----\n${"QkFTRTY0".repeat(12)}\n${"U1lOVEhFVElD".repeat(8)}\n-----END RSA PRIVATE KEY-----`,
  password: "synthetic-password-negative-control",
};
export const guardHarmless = `sha=${"a0".repeat(32)} uuid=123e4567-e89b-12d3-a456-426614174000 base64=${"YWJj".repeat(24)} certificate=-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE----- code=const colorToken = 0;`;
export const guardOutput = '{"errors":[],"ok":false,"count":0,"result":"Captured answer is unchanged."}';
export const guardTraceId = "102030405060708090a0b0c0d0e0f036";
export const guardSpanId = "1020304050607036";
export function guardEvent(action = "allow", overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { "guard.name": "Prompt policy", "guard.phase": "preflight", "guard.action": action,
    "guard.score": 0, "guard.classification": "local fixture", "guard.explanation": "Producer reported a decision.", "guard.latency_ms": 0, "guard.error": false, ...overrides };
  return { name: "guard.evaluation", timeUnixNano: "1770000000000000002", droppedAttributesCount: 0,
    attributes: Object.entries(values).map(([key, value]) => ({ key, value: typeof value === "string" ? { stringValue: value }
      : typeof value === "boolean" ? { boolValue: value } : { doubleValue: value } })) };
}
export function guardRequest() {
  const body = fidelityRequest(), span = body.resourceSpans[0].scopeSpans[0].spans[0];
  span.traceId = guardTraceId; span.spanId = guardSpanId; span.name = "Captured guard review";
  span.droppedEventsCount = 0; span.droppedLinksCount = 0; span.links = [];
  span.attributes[2].value.stringValue = guardOutput;
  body.resourceSpans[0].scopeSpans[0].scope.droppedAttributesCount = 0;
  // Heterogeneous OTLP AnyValue variants are intentional source data.
  (span as unknown as Record<string, unknown>).events = [guardEvent("allow"), guardEvent("warn", { "guard.phase": "postflight" }),
    guardEvent("redact"), guardEvent("deny"), guardEvent("allow", { "guard.name": "Fail-open observation", "guard.error": true,
      "guard.explanation": "Producer reported an evaluation error and allowed continuation." })];
  return body;
}
