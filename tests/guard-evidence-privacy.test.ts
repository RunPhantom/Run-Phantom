import { afterEach, expect, test } from "bun:test";
import { captureOtlpEvidence, validateOtlpEvidence } from "../src/spans/otlp-evidence";
import { buildRedactionPolicy, defaultIsSensitiveKey, resetActiveRedactionPolicy, scrubKnownSecrets, setActiveRedactionPolicy } from "../src/verification/redaction";
import { redactText } from "../src/verification/serialization";
import { guardEvent, guardHarmless, guardSecrets } from "./fixtures/guard-evidence";

afterEach(resetActiveRedactionPolicy);

test("high-confidence credential formats are removed completely while hashes, certificates and code survive", () => {
  for (const secret of [guardSecrets.npm, guardSecrets.hf, guardSecrets.pem]) {
    expect(scrubKnownSecrets(`before ${secret} after`)).toBe("before [REDACTED] after");
  }
  expect(scrubKnownSecrets(guardHarmless)).toBe(guardHarmless);
});

test("captured receipt privacy retains a mandatory default floor under ambient exemptions", () => {
  setActiveRedactionPolicy(buildRedactionPolicy({ allow: ["password", "access_token"] }));
  const event = guardEvent("allow", { "guard.explanation": `password=${guardSecrets.password} https://local.test/?access_token=${guardSecrets.password}&order=A-42` });
  const receipt = captureOtlpEvidence({ events: [event], droppedEventsCount: 0 }, {}, {});
  expect(JSON.stringify(receipt)).not.toContain(guardSecrets.password);
  validateOtlpEvidence(receipt);
  const unsafe = structuredClone(receipt);
  unsafe.events[0].attributes[5].value = { stringValue: `password=${guardSecrets.password}` };
  expect(() => validateOtlpEvidence(unsafe)).toThrow();
  // The existing browser ambient exemption remains a supported choice outside receipt evidence.
  expect(redactText(`password=${guardSecrets.password}`)).toContain(guardSecrets.password);
  expect(redactText(`password=${guardSecrets.password}`, defaultIsSensitiveKey)).not.toContain(guardSecrets.password);
});

test("complete multi-line credentials are scrubbed before a receipt applies its text cap", () => {
  const secret = `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n${"QkFTRTY0\n".repeat(900)}${["-----END", "PRIVATE KEY-----"].join(" ")}`;
  const receipt = captureOtlpEvidence({ events: [guardEvent("deny", { "guard.explanation": `before ${secret} after` })] }, {}, {});
  expect(receipt.events[0].attributes[5].value).toEqual({ stringValue: "before [REDACTED] after" });
  expect(receipt.capture.redactedValues).toBe(1); expect(receipt.capture.truncatedValues).toBe(0);
});
