import type { FailureHandoff, Predicate, VerificationReport, VerificationReportContext } from "./protocol";
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
    if (check.controlSource && !controlSource || check.controlSourceOmitted === "context-limit") context.truncated = true;
    if (controlSource?.observation.status === "unavailable" && controlSource.observation.reason === "redacted") context.redacted = true;
    const retained = { step: check.step, predicate: predicate(check.predicate), status: check.status,
      reason: reason.slice(0, L.MAX_REASON_LENGTH), since: check.since, through: check.through,
      generation: check.generation, coverage: { ...check.coverage }, complete: check.complete,
      dropped: check.dropped, settled: check.settled, ...(controlSource ? { controlSource } : {}),
      ...(!controlSource && check.controlSourceOmitted === "context-limit" ? { controlSourceOmitted: "context-limit" as const } : {}) };
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
    // Optional location context must yield before existing expectations or captured readings.
    // The next loop measures the omission marker and truncated flag as part of the same budget.
    const sources = context.checks.filter(check => check.controlSource).sort((a, b) =>
      Buffer.byteLength(JSON.stringify(b.controlSource)) - Buffer.byteLength(JSON.stringify(a.controlSource)));
    if (sources.length) {
      delete sources[0].controlSource;
      sources[0].controlSourceOmitted = "context-limit";
      context.truncated = true;
      continue;
    }
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
    if (groups.length) {
      groups[0].causal!.readings = [];
      groups[0].causal!.omitted = true;
      groups[0].causal!.attribution = "unavailable";
      context.truncated = true;
      continue;
    }
    // Human display reasons are optional context; the report's evaluated reason is untouched.
    const reasons = context.checks.map(check => ({ check, bytes: Buffer.byteLength(JSON.stringify(check.reason)) }))
      .sort((a, b) => b.bytes - a.bytes);
    if (reasons[0]?.bytes > Buffer.byteLength(JSON.stringify("[TRUNCATED]"))) {
      reasons[0].check.reason = "[TRUNCATED]";
      context.truncated = true;
      continue;
    }
    throw new Error("Saved verification context exceeds its required outcome budget");
  }
  return context;
}

/** Advice describes an already retained report; it never interprets agent completion prose. */
export function buildFailureHandoff(report: VerificationReport): FailureHandoff {
  const validStatus = (value: unknown) => value === "pass" || value === "fail" || value === "inconclusive";
  if (!validStatus(report.status)) throw new Error("Retained report outcome unavailable");
  let redacted = report.context?.redacted ?? false;
  let truncated = report.context?.truncated ?? false;
  const clean = (value: unknown) => {
    const result = sanitizeWithReport(value);
    redacted ||= !!result.redacted;
    truncated ||= !!result.truncation;
    return result.value;
  };
  const text = (value: string) => { const result = clean(value); return typeof result === "string" ? result : "[REDACTED]"; };
  const context = report.context ? boundReportContext(report.context) : undefined;
  redacted ||= context?.redacted ?? false;
  truncated ||= context?.truncated ?? false;
  const checks = (context?.checks ?? []).map(check => {
    if (!validStatus(check.status) || ![check.step, check.since, check.through, check.generation, check.dropped].every(Number.isSafeInteger)
      || check.step < 1 || check.since < 0 || check.through < check.since || check.generation < 0 || check.dropped < 0
      || typeof check.complete !== "boolean" || typeof check.settled !== "boolean") throw new Error("Retained check outcome unavailable");
    return { step: check.step, predicate: clean(check.predicate), status: check.status, actual: text(check.reason),
      since: check.since, through: check.through, generation: check.generation, complete: check.complete, dropped: check.dropped,
      settled: check.settled, coverage: { ...check.coverage }, ...(check.controlSource ? { controlSource: check.controlSource } : {}),
      ...(check.controlSourceOmitted ? { controlSourceOmitted: check.controlSourceOmitted } : {}), ...(check.causal ? { causal: check.causal } : {}) };
  });
  const handoff: FailureHandoff = { reportId: report.id, name: text(report.name), status: report.status, reason: text(report.reason),
    origin: context ? text(context.origin) : null, reproduction: "partial",
    reproductionNote: "This is retained outcome evidence, not a replay script. Original actions and entered values were not retained in this report. Reproduce explicitly in the recorded application and recheck the declared expectation; no command has been run by this handoff.",
    checks, checksOmitted: Math.max(0, (report.context?.checks.length ?? 0) - checks.length), redacted, truncated };
  while (Buffer.byteLength(JSON.stringify(handoff)) > 16384 && handoff.checks.length) {
    handoff.checks.pop(); handoff.checksOmitted++; handoff.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(handoff)) > 16384) throw new Error("Retained handoff exceeds its byte bound");
  return handoff;
}
