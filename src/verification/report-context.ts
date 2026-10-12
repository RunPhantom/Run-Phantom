import type { Predicate, VerificationReportContext } from "./protocol";
import { VERIFICATION_LIMITS as L } from "./protocol";
import { parseFlowSteps, parseRelativeTarget } from "./validation";
import { sanitizeWithReport } from "./serialization";
import { boundControlSource } from "./build/source";

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
    try { parsed = parseFlowSteps([{ command: { type: "click", selector: ":root" }, predicate: raw }])[0].predicate; }
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
      case "relative": return { kind: parsed.kind, target: clean(parsed.target), relation: parsed.relation,
        ...(parsed.relation === "becomes" ? { equals: clean(parsed.equals) } : {}) };
      case "allOf": case "anyOf": return { kind: parsed.kind, predicates: parsed.predicates.map(predicate) };
    }
  };
  for (const check of input.checks.slice(0, L.MAX_STEPS)) {
    const reason = String(clean(check.reason));
    if (reason.length > L.MAX_REASON_LENGTH) context.truncated = true;
    const controlSource = check.controlSource ? boundControlSource(check.controlSource, value => String(clean(value))) : undefined;
    if (check.controlSource && !controlSource) context.truncated = true;
    if (controlSource?.observation.status === "unavailable" && controlSource.observation.reason === "redacted") context.redacted = true;
    const retained = { step: check.step, predicate: predicate(check.predicate), status: check.status,
      reason: reason.slice(0, L.MAX_REASON_LENGTH), since: check.since, through: check.through,
      generation: check.generation, coverage: { ...check.coverage }, complete: check.complete,
      dropped: check.dropped, settled: check.settled, ...(controlSource ? { controlSource } : {}) };
    if (check.causal) {
      let unavailable = check.causal.attribution !== "captured";
      const readings: NonNullable<typeof check.causal>["readings"] = [];
      for (const pair of check.causal.readings.slice(0, L.MAX_BASELINE_TARGETS)) {
        let target;
        try { target = parseRelativeTarget(pair.target); }
        catch { context.redacted = true; unavailable = true; continue; }
        const safeTarget = scrub(target);
        context.redacted ||= safeTarget.redacted;
        context.truncated ||= safeTarget.truncated;
        unavailable ||= safeTarget.redacted || safeTarget.truncated;
        const retain = (reading: typeof pair.before): typeof pair.before => {
          if (!reading) { unavailable = true; return null; }
          const safe = scrub(reading.value);
          context.redacted ||= safe.redacted;
          context.truncated ||= safe.truncated;
          unavailable ||= reading.availability !== "complete" || safe.redacted || safe.truncated;
          return { cursor: reading.cursor, availability: safe.redacted || safe.truncated ? "partial" : reading.availability, value: safe.value };
        };
        readings.push({ target: safeTarget.value as typeof target, before: retain(pair.before), after: retain(pair.after) });
      }
      const omitted = check.causal.omitted || check.causal.readings.length > L.MAX_BASELINE_TARGETS;
      context.truncated ||= !!omitted;
      context.checks.push({ ...retained, causal: { source: "sdk-reported", attribution: unavailable || omitted ? "unavailable" : "captured",
        ...(check.causal.actionId ? { actionId: String(clean(check.causal.actionId)) } : {}),
        ...(omitted ? { omitted: true } : {}), readings } });
    } else context.checks.push(retained);
  }
  // Preserve every executed check's outcome/window even when large expected values do not fit.
  while (Buffer.byteLength(JSON.stringify(context)) > L.MAX_CONTEXT_BYTES) {
    const values = context.checks.flatMap(check => (check.causal?.readings ?? []).flatMap(pair => [pair.before, pair.after]
      .flatMap(reading => reading ? [{ check, reading, bytes: Buffer.byteLength(JSON.stringify(reading.value)) }] : [])))
      .sort((a, b) => b.bytes - a.bytes);
    if (values[0]?.bytes > 128) {
      values[0].reading.value = "[TRUNCATED]";
      values[0].reading.availability = "partial";
      values[0].check.causal!.attribution = "unavailable";
      context.truncated = true;
      continue;
    }
    const largest = context.checks.map((check, index) => ({ index, bytes: Buffer.byteLength(JSON.stringify(check.predicate)) }))
      .sort((a, b) => b.bytes - a.bytes)[0];
    if (largest?.bytes > 32) { context.checks[largest.index].predicate = "[TRUNCATED]"; context.truncated = true; continue; }
    const groups = context.checks.filter(check => check.causal?.readings.length).sort((a, b) =>
      Buffer.byteLength(JSON.stringify(b.causal!.readings)) - Buffer.byteLength(JSON.stringify(a.causal!.readings)));
    if (!groups.length) break;
    groups[0].causal!.readings = [];
    groups[0].causal!.omitted = true;
    groups[0].causal!.attribution = "unavailable";
    context.truncated = true;
  }
  return context;
}
