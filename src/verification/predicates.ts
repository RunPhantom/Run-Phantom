/** Assertion evaluators over captured runtime evidence.
 *
 * Every evaluator is tri-state. Missing observer coverage, lost evidence,
 * truncation or redaction produce an inconclusive verdict rather than a false
 * pass, because an assertion that cannot see its evidence has not been proven.
 */
import { VERIFICATION_LIMITS as L, type Predicate, type PredicateContext, type RuntimeEvent, type Verdict } from "./protocol";
import { selectPath } from "./state-select";
import { isSensitiveKey } from "./redaction";
import { sanitizeWithReport } from "./serialization";

/** the runtime verification module strict structural equality, with own-property and recursion guards. */
export function structurallyEqual(got: unknown, want: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (got === want) return true;
  if (got === null || want === null || typeof got !== "object" || typeof want !== "object") return false;
  if (Array.isArray(got) !== Array.isArray(want)) return false;
  if (Array.isArray(got) && Array.isArray(want)) {
    return got.length === want.length && got.every((v, i) => Object.hasOwn(want, i) && structurallyEqual(v, want[i], depth + 1));
  }
  const a = got as Record<string, unknown>, b = want as Record<string, unknown>;
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  return names.every((name) => Object.hasOwn(b, name) && structurallyEqual(a[name], b[name], depth + 1));
}

/** Placeholders describe the recorder, never a value an application assertion can prove. */
export function hasUnavailableValue(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > 16 || value === undefined) return true;
  if (typeof value === "string") return /\[(?:REDACTED|TRUNCATED|UNSERIALIZABLE|CIRCULAR)\]/.test(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    const names = Object.keys(value);
    if (names.length > 1000) return true;
    return names.some((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || !("value" in descriptor) || hasUnavailableValue(descriptor.value, depth + 1, seen);
    });
  } catch { return true; }
  finally { seen.delete(value); }
}

export function boundEvidence(events: RuntimeEvent[]): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const seen = new Set<RuntimeEvent>();
  let bytes = 2;
  for (const event of events) {
    if (seen.has(event)) continue;
    seen.add(event);
    const sanitized = sanitizeWithReport(event);
    const safe = sanitized.value as RuntimeEvent;
    if (typeof safe !== "object" || safe === null || typeof safe.t !== "number" || typeof safe.type !== "string" || typeof safe.data !== "object") continue;
    if (sanitized.redacted || sanitized.truncation) safe.truncated = true;
    const size = new TextEncoder().encode(JSON.stringify(safe)).byteLength + 1;
    if (out.length >= L.MAX_EVIDENCE_EVENTS || bytes + size > L.MAX_EVIDENCE_BYTES) break;
    bytes += size;
    out.push(safe);
  }
  return out;
}

export function evaluatePredicate(predicate: Predicate, context: PredicateContext): Verdict {
  const verdict = (status: Verdict["status"], reason: string, evidence: RuntimeEvent[] = []): Verdict =>
    ({ status, reason: reason.slice(0, L.MAX_REASON_LENGTH), evidence: boundEvidence(evidence) });
  const unknown = (reason: string, evidence: RuntimeEvent[] = []) => verdict("inconclusive", reason, evidence);

  if (predicate.kind === "allOf" || predicate.kind === "anyOf") {
    if (predicate.predicates.length === 0) return unknown("An empty composite proves no observable consequence.");
    const results = predicate.predicates.map((part) => evaluatePredicate(part, context));
    if (predicate.kind === "allOf") {
      const failed = results.find((r) => r.status === "fail");
      if (failed) return failed;
      const incomplete = results.find((r) => r.status === "inconclusive");
      if (incomplete) return incomplete;
      return verdict("pass", "Every declared predicate held within the observed interval.", results.flatMap((r) => r.evidence));
    }
    const passed = results.find((r) => r.status === "pass");
    if (passed) return passed;
    const incomplete = results.find((r) => r.status === "inconclusive");
    if (incomplete) return incomplete;
    return verdict("fail", "No declared alternative held within the observed interval.", results.flatMap((r) => r.evidence));
  }

  const observer = predicate.kind === "element" ? "dom" : predicate.kind;
  if (!context.coverage[observer]) return unknown(`The ${observer} observer did not continuously cover this assertion.`);
  const relevantErrors = context.events.filter((e) => e.type === "capture.loss"
    || (e.type === "observer.error" && e.data.observer === observer));
  if (!context.complete || relevantErrors.length) return unknown("Capture was incomplete; missing evidence cannot establish this predicate.", relevantErrors);
  const clean = (event: RuntimeEvent): boolean => !event.truncated;
  const relevant = context.events.filter((e) => context.actionId === undefined || e.actionId === context.actionId
    || e.type === "state" || e.type === "dom");
  const missing = (what: string, events: RuntimeEvent[] = []): Verdict => context.settled
    ? verdict("fail", `${what} was not observed during the completed observation interval.`, events)
    : unknown(`${what} has not been observed; the capture has not reached a bounded quiet interval.`, events);

  switch (predicate.kind) {
    case "network": {
      // Completion time cannot move a request started before this action into its evidence.
      const starts = new Set(relevant.filter((e) => e.type === "network.start" && clean(e)).map((e) => e.data.requestId));
      const candidates = relevant.filter((e) => e.type === "network" && typeof e.data.url === "string"
        && e.data.url.includes(predicate.urlContains)
        && (predicate.method === undefined || typeof e.data.method === "string" && e.data.method.toUpperCase() === predicate.method.toUpperCase()));
      const available = candidates.filter((e) => clean(e) && typeof e.data.requestId === "string" && starts.has(e.data.requestId)
        && !hasUnavailableValue(e.data.url));
      const match = available.find((e) => predicate.status === undefined || e.data.status === predicate.status);
      if (match) return verdict("pass", "A request started and completed in this observation interval with the declared outcome.", [match]);
      if (candidates.some((e) => !clean(e) || hasUnavailableValue(e.data.url))) return unknown("The matching network evidence was truncated or redacted.", candidates);
      return missing("The declared network outcome", available);
    }
    case "console": {
      const events = relevant.filter((e) => e.type === "console" && e.data.level === predicate.level);
      if (events.length > 0) {
        // The error level itself is observable even when a secret in its message was redacted.
        return verdict(predicate.absent ? "fail" : "pass", `${events.length} console ${predicate.level} event(s) occurred within the observed interval.`, events);
      }
      if (!predicate.absent) return missing(`A console ${predicate.level} event`);
      if (!context.coverage.network || !context.settled) return unknown("Console absence requires continuous network coverage and a completed quiet interval with no pending requests.");
      return verdict("pass", `No console ${predicate.level} events were observed through the completed quiet interval; this does not predict later behavior.`);
    }
    case "signal": {
      const candidates = relevant.filter((e) => e.type === "signal" && e.data.name === predicate.name);
      const match = candidates.find((e) => clean(e) && !hasUnavailableValue(e.data.name));
      if (match) return verdict("pass", "The declared signal was observed in this interval.", [match]);
      if (candidates.length) return unknown("The signal observation was incomplete.", candidates);
      return missing("The declared signal");
    }
    case "state": {
      if (predicate.path.split(".").some(isSensitiveKey) || hasUnavailableValue(predicate.equals)) return unknown("Credential paths and unavailable expected values cannot establish a state assertion.");
      const events = relevant.filter((e) => e.type === "state" && e.data.store === predicate.store);
      const latest = events.at(-1);
      if (!latest || !Object.hasOwn(latest.data, "value")) return unknown("The requested state store could not be read.");
      if (!clean(latest)) return unknown("The state read was truncated or redacted.", [latest]);
      const selected = selectPath(latest.data.value, predicate.path);
      if (!selected.found || hasUnavailableValue(selected.value)) return unknown("The requested state path is missing, redacted or truncated.", [latest]);
      const equal = structurallyEqual(selected.value, predicate.equals);
      if (!equal && !context.settled) return unknown("The current state differs, and observation is still in progress.", [latest]);
      return verdict(equal ? "pass" : "fail", equal ? "The readable state value equals the declared expectation." : "The readable state value differs from the declared expectation.", [latest]);
    }
    case "element": {
      const latest = relevant.filter((e) => e.type === "dom" && e.data.selector === predicate.selector).at(-1);
      if (!latest || !clean(latest) || typeof latest.data.count !== "number" || !Number.isSafeInteger(latest.data.count) || latest.data.count < 0) {
        return unknown("The requested element could not be read completely.", latest ? [latest] : []);
      }
      const present = latest.data.count > 0;
      if (predicate.state === "absent" && !present && (!context.coverage.network || !context.settled)) return unknown("Element absence requires a completed quiet interval with no pending requests.", [latest]);
      if (predicate.state === "present" && !present && !context.settled) return unknown("The element is not present yet; observation is still in progress.", [latest]);
      const pass = predicate.state === "present" ? present : !present;
      return verdict(pass ? "pass" : "fail", `The selector matched ${latest.data.count} element(s) in the observed document.`, [latest]);
    }
  }
}
