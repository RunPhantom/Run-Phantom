import { afterEach, expect, test } from "bun:test";
import { redactText } from "../src/verification/serialization";
import { buildRedactionPolicy, defaultIsSensitiveKey, resetActiveRedactionPolicy, setActiveRedactionPolicy } from "../src/verification/redaction";

afterEach(resetActiveRedactionPolicy);
test("mandatory text predicate survives ambient key and URL credential exemptions", () => {
  setActiveRedactionPolicy(buildRedactionPolicy({ allow: ["password", "access_token"] }));
  const text = 'password=synthetic-password https://example.invalid/?access_token=synthetic-query';
  expect(redactText(text)).toBe(text);
  const safe = redactText(text, defaultIsSensitiveKey);
  expect(safe).not.toContain("synthetic-password");
  expect(safe).not.toContain("synthetic-query");
  expect(redactText('const $part = "ordinary"; colorToken=blue', defaultIsSensitiveKey))
    .toBe('const $part = "ordinary"; colorToken=blue');
});
test("existing default text callers preserve their redaction and literal controls", () => {
  const text = 'password=synthetic-password https://example.invalid/?access_token=synthetic-query';
  expect(redactText(text)).toBe(redactText(text, defaultIsSensitiveKey));
  expect(redactText('hash=' + 'a'.repeat(64) + ' / 79c6b7b8-bf9d-46b2-9bfa-6b415b5aa3a1')).toContain('a'.repeat(64));
});
