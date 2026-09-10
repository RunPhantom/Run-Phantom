import type { Predicate, VerificationReportContext } from "./protocol";
import { VERIFICATION_LIMITS as L } from "./protocol";
import { parseFlowSteps } from "./validation";
import { sanitizeWithReport } from "./serialization";

interface Sanitized { value: unknown; redacted: boolean; truncated: boolean }
type Scrub = (value: unknown) => Sanitized;
const persistenceScrub: Scrub = (value) => {
  const result = sanitizeWithReport(value);
  return { value: result.value, redacted: !!result.redacted, truncated: !!result.truncation };
};

/** Durable expectations use saved-flow policy, without storing actions or entered values. */
export function boundReportContext(input: VerificationReportContext, scrub: Scrub = persistenceScrub): VerificationReportContext {
  const context: VerificationReportContext = { origin: input.origin, checks: [], quietMs: input.quietMs,
    redacted: input.redacted, truncated: input.truncated || input.checks.length > L.MAX_STEPS };
  const clean = (value: unknown): unknown => {
    const result = scrub(value);
    context.redacted ||= result.redacted;
    context.truncated ||= result.truncated;
    return result.value;
  };
  const predicate = (raw: unknown): unknown => {
    if (raw === "[TRUNCATED]") { context.truncated = true; return raw; }
    if (raw === "[REDACTED]") { context.redacted = true; return raw; }
    let parsed: Predicate;
    try { parsed = parseFlowSteps([{ predicate: raw }])[0].predicate; }
    catch {
      // Live credential-oriented checks are allowed to return inconclusive, but their
      // selectors/expectations must never become durable secrets after that verdict.
      context.redacted = true;
      const inspected = scrub(raw);
      context.truncated ||= inspected.truncated;
      return "[REDACTED]";
    }
    switch (parsed.kind) {
      case "console": return { kind: parsed.kind, level: parsed.level, absent: parsed.absent };
      case "network": return { kind: parsed.kind, urlContains: clean(parsed.urlContains),
        ...(parsed.method === undefined ? {} : { method: clean(parsed.method) }),
        ...(parsed.status === undefined ? {} : { status: parsed.status }) };
      case "signal": return { kind: parsed.kind, name: clean(parsed.name) };
      case "state": return { kind: parsed.kind, store: clean(parsed.store), path: clean(parsed.path), equals: clean(parsed.equals) };
      case "element": return { kind: parsed.kind, selector: clean(parsed.selector), state: parsed.state };
      case "allOf": case "anyOf": return { kind: parsed.kind, predicates: parsed.predicates.map(predicate) };
    }
  };
  for (const check of input.checks.slice(0, L.MAX_STEPS)) {
    const reason = String(clean(check.reason));
    if (reason.length > L.MAX_REASON_LENGTH) context.truncated = true;
    context.checks.push({ step: check.step, predicate: predicate(check.predicate), status: check.status,
      reason: reason.slice(0, L.MAX_REASON_LENGTH), since: check.since, through: check.through,
      generation: check.generation, coverage: { ...check.coverage }, complete: check.complete,
      dropped: check.dropped, settled: check.settled });
  }
  // Preserve every executed check's outcome/window even when large expected values do not fit.
  while (Buffer.byteLength(JSON.stringify(context)) > L.MAX_CONTEXT_BYTES) {
    const largest = context.checks.map((check, index) => ({ index, bytes: Buffer.byteLength(JSON.stringify(check.predicate)) }))
      .sort((a, b) => b.bytes - a.bytes)[0];
    if (!largest || largest.bytes <= 32) break;
    context.checks[largest.index].predicate = "[TRUNCATED]";
    context.truncated = true;
  }
  return context;
}
