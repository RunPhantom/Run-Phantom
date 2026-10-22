/** Assertion evaluators over captured runtime evidence.
 *
 * Every evaluator is tri-state. Missing observer coverage, lost evidence,
 * truncation or redaction produce an inconclusive verdict rather than a false
 * pass, because an assertion that cannot see its evidence has not been proven.
 */
import { BUSINESS_CAPABILITY, relativeTargetKey, VERIFICATION_LIMITS as L, type Coverage, type Predicate, type PredicateContext, type RuntimeEvent, type Verdict } from "./protocol";
import { selectPath } from "./state-select";
import { isSensitiveKey } from "./redaction";
import { sanitizeWithReport } from "./serialization";
import { evaluatePerformancePredicate, type PerformanceSnapshot } from "./performance";
import {
  baselineCursor, captureBaselineReading, captureBaselineScope, isCapturedAttribution, sameBaselineScope,
  type BaselineReading, type BaselineScope, type CausalAttribution, type OperationReading,
} from "./baseline";

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

export interface EvaluationContext extends PredicateContext {
  performance?: { snapshot: PerformanceSnapshot; fresh: boolean };
  relative?: ReadonlyMap<string, { scope: BaselineScope; input: CausalPredicateContext }>;
}

export function evaluatePredicate(predicate: Predicate, context: EvaluationContext): Verdict {
  const verdict = (status: Verdict["status"], reason: string, evidence: RuntimeEvent[] = []): Verdict =>
    ({ status, reason: reason.slice(0, L.MAX_REASON_LENGTH), evidence: boundEvidence(evidence) });
  const unknown = (reason: string, evidence: RuntimeEvent[] = []) => verdict("inconclusive", reason, evidence);
  if (predicate.kind === "performance") return evaluatePerformancePredicate(predicate, context.performance?.snapshot, context.performance?.fresh === true);

  if (predicate.kind === "relative") {
    const captured = context.relative?.get(relativeTargetKey(predicate.target));
    if (!captured) return unknown("A relative check requires a matching captured pre/action/post result; interval observations alone are insufficient.");
    return evaluateCausalPredicate({ scope: captured.scope, relation: predicate.relation,
      ...(predicate.relation === "becomes" ? { equals: predicate.equals } : {}) } as CausalPredicate, captured.input);
  }

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

  if (predicate.kind === "business-response") {
    if (!context.capabilities?.includes(BUSINESS_CAPABILITY)) return unknown("Response evidence is off or unavailable. Pair with response capture enabled.");
    if (!context.coverage.network || !context.complete || context.events.some(event => event.type === "capture.loss" || event.type === "observer.error" && event.data.observer === "network")) {
      return unknown("Response capture was incomplete; missing bytes or requests cannot establish a business contract.");
    }
    if (hasUnavailableValue(predicate.equals) || hasUnavailableValue(predicate.operationId)) return unknown("Unavailable expectations cannot establish a business contract.");
    const relevant = context.events.filter(event => context.actionId === undefined || event.actionId === context.actionId || event.type === "state");
    const matchingStarts = relevant.filter(event => event.type === "network.start"
      && typeof event.data.url === "string" && !hasUnavailableValue(event.data.url) && event.data.url.includes(predicate.urlContains)
      && (predicate.method === undefined || event.data.method === predicate.method));
    if (new Set(matchingStarts.map(event => event.data.requestId)).size !== matchingStarts.length) return unknown("Response request identities were reused; an older body cannot identify a later request.", matchingStarts);
    const starts = new Map(matchingStarts.filter(event => !event.truncated).map(event => [event.data.requestId, event]));
    const responses = relevant.filter(event => event.type === "network" && !event.truncated && starts.has(event.data.requestId));
    const identities = new Set(responses.map(event => event.data.requestId));
    const bodies = relevant.filter(event => event.type === "network.body" && identities.has(event.data.requestId));
    const candidates = bodies.filter(event => event.data.state !== "pending");
    const matched = candidates.filter(event => event.data.state === "complete" && Object.hasOwn(event.data, "body")
      && selectPath(event.data.body, predicate.operationPath).value === predicate.operationId);
    const body = matched.at(-1);
    if (!body) return unknown("No complete response with the declared operation identity was observed. Headers and idle streams do not establish completion.", bodies);
    if (body.truncated || body.data.redacted === true || hasUnavailableValue(body.data.body)) return unknown("The response body was redacted or truncated; the business contract remains unknown.", [body]);
    const start = starts.get(body.data.requestId)!;
    const laterLifecycles = relevant.filter(event => (event.type === "network.start" || event.type === "network")
      && event.t > start.t && event.data.requestId !== body.data.requestId
      && (starts.has(event.data.requestId) || typeof event.data.url === "string" && event.data.url.includes(predicate.urlContains)
        && (predicate.method === undefined || event.data.method === predicate.method)));
    if (laterLifecycles.length) return unknown("A later matching request has unresolved identity or completion; an older response cannot establish its business contract.", [body, ...laterLifecycles]);
    // A later incomplete request for this URL can carry the same operation. It cannot be silently ignored.
    if (bodies.some(event => event.t > body.t && event.data.requestId !== body.data.requestId)) return unknown("A later matching response has unresolved identity or completion.", bodies);
    const response = responses.find(event => event.data.requestId === body.data.requestId)!;
    const selected = selectPath(body.data.body, predicate.path);
    if (!selected.found || hasUnavailableValue(selected.value)) return unknown("The declared response path was missing or unavailable.", [body]);
    if (!structurallyEqual(selected.value, predicate.equals)) return verdict("fail", "The complete SDK-reported response differs from the declared business value.", [body]);
    if (predicate.phase === "acceptance" && !(typeof response.data.status === "number" && response.data.status >= 200 && response.data.status < 300)) {
      return verdict("fail", "The declared acceptance response did not have a successful HTTP status.", [response, body]);
    }
    const evidence = [response, body];
    if (predicate.witness) {
      const witness = predicate.witness;
      const observed = relevant.filter(event => witness.kind === "state" ? event.type === "state" && event.data.store === witness.store
        : event.type === "signal" && event.data.name === witness.name).at(-1);
      if (!context.coverage[witness.kind] || !observed || observed.truncated) return unknown("The declared cross-channel witness was unavailable; absence cannot mean agreement.", evidence);
      const value = witness.kind === "state" ? observed.data.value : observed.data.data;
      const operation = selectPath(value, witness.operationPath);
      const reading = selectPath(value, witness.path);
      if (!operation.found || operation.value !== predicate.operationId || !reading.found || hasUnavailableValue(reading.value)) return unknown("The witness did not expose a readable value for the same declared operation.", [...evidence, observed]);
      evidence.push(observed);
      if (!structurallyEqual(reading.value, selected.value)) return verdict("fail", "The declared response and cross-channel witness disagree for the same operation.", evidence);
    }
    if (predicate.phase === "final") return unknown("SDK-reported response and app witnesses cannot authenticate final business server persistence. An independent server witness is unavailable.", evidence);
    return verdict("pass", predicate.phase === "acceptance"
      ? "The complete SDK-reported response met the declared acceptance contract; final persistence is still unverified."
      : "The complete SDK-reported response met the declared response contract; this does not authenticate business server persistence.", evidence);
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

export type CausalPredicate = {
  readonly scope: BaselineScope;
  readonly requiredOutcome?: OperationReading;
} & (
  | { readonly relation: "changed" | "increased" | "decreased" }
  | { readonly relation: "becomes"; readonly equals: unknown }
);

export interface CausalPredicateContext {
  readonly before?: BaselineReading | null;
  readonly after?: BaselineReading | null;
  readonly action: {
    readonly id: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly cursor: number;
    readonly acknowledged: boolean;
  };
  readonly through: number;
  readonly coverage: Coverage;
  readonly complete: boolean;
  readonly settled: boolean;
  readonly attribution?: CausalAttribution;
}

/** Relative checks need captured result correlation in addition to the action interval.
 * Standalone state/element checks continue to use evaluatePredicate and need no causal baseline.
 */
export function evaluateCausalPredicate(predicate: CausalPredicate, context: CausalPredicateContext): Verdict {
  const events = [context.before, context.after].flatMap((reading, index): RuntimeEvent[] => reading ? [{
    t: reading.cursor, type: "verification.baseline", ...(reading.actionId ? { actionId: reading.actionId } : {}),
    data: { phase: index === 0 ? "before" : "after", generation: reading.scope.generation,
      scope: { kind: reading.scope.kind, target: reading.scope.target, ...(reading.scope.path === undefined ? {} : { path: reading.scope.path }) },
      availability: reading.availability, fresh: reading.fresh, value: reading.value },
  }] : []);
  const verdict = (status: Verdict["status"], reason: string): Verdict => ({ status, reason, evidence: boundEvidence(events) });
  const unknown = (reason: string) => verdict("inconclusive", reason);
  let scope: BaselineScope;
  try {
    scope = captureBaselineScope(predicate.scope);
    baselineCursor(context.action.cursor);
    baselineCursor(context.through);
  } catch { return unknown("The declared scope or action interval is invalid."); }
  const observer = scope.kind === "state" ? "state" : "dom";
  if (context.coverage[observer] !== true || context.coverage.network !== true || context.complete !== true) return unknown("Continuous complete scope and network observer coverage is required for a relative assertion.");
  if (context.action.acknowledged !== true) return unknown("The action boundary was not acknowledged.");
  if (context.action.sessionId !== scope.sessionId || context.action.generation !== scope.generation) return unknown("The action belongs to another session or document generation.");
  const { before, after } = context;
  if (!before || !after) return unknown("Both a pre-action baseline and a fresh post-action reading are required.");
  if (!sameBaselineScope(before.scope, scope) || !sameBaselineScope(after.scope, scope)) return unknown("The readings do not cover the exact declared session, document, and target scope.");
  if (before.availability !== "complete" || after.availability !== "complete" || !before.complete || !after.complete
    || hasUnavailableValue(before.value) || hasUnavailableValue(after.value)) return unknown("A baseline or result reading is unavailable, partial, or redacted.");
  if (before.fresh !== true || after.fresh !== true) return unknown("The baseline and result must come from acknowledged fresh reads.");
  if (!(before.cursor < context.action.cursor && context.action.cursor < after.cursor && after.cursor <= context.through)) return unknown("The readings do not bracket the acknowledged action boundary.");
  if (context.action.cursor - before.cursor > L.MAX_EVENT_AGE_MS || context.through - after.cursor > L.MAX_EVENT_AGE_MS) return unknown("A reading is stale for the declared action interval.");
  if (!context.action.id || after.actionId !== context.action.id) return unknown("The post-action reading is not attributed to this exact action.");
  const attribution = context.attribution;
  if (!isCapturedAttribution(attribution)) return unknown("An action interval alone does not link a change to the action; a captured result or declared operation is required.");
  if (attribution.actionId !== context.action.id || !sameBaselineScope(attribution.scope, scope)
    || attribution.cursor < after.cursor || attribution.cursor > context.through
    || attribution.baseline.cursor !== before.cursor || !structurallyEqual(attribution.baseline.value, before.value)
    || attribution.reading.cursor !== after.cursor || !structurallyEqual(attribution.reading.value, after.value)) {
    return unknown("The captured result does not correlate this exact action and scoped result reading.");
  }
  const capturedOutcome = attribution.reading.outcome;
  if ((after.outcome === undefined) !== (capturedOutcome === undefined)
    || after.outcome && capturedOutcome && (after.outcome.operationId !== capturedOutcome.operationId || after.outcome.phase !== capturedOutcome.phase)) {
    return unknown("The result reading and captured operation identity or phase disagree.");
  }
  if (predicate.requiredOutcome) {
    const required = predicate.requiredOutcome;
    const outcome = attribution.reading.outcome;
    if (attribution.source !== "declared-operation" || !outcome || outcome.operationId !== required.operationId) return unknown("The declared operation identity was not correlated with this action result.");
    if (required.phase !== "accepted" && required.phase !== "final") return unknown("The declared outcome phase is invalid.");
    if (outcome.phase !== required.phase) return unknown(required.phase === "final"
      ? "The request was accepted; final persistence has not been established."
      : "The captured operation phase does not establish the declared acceptance-only contract.");
  }
  if (!context.settled) return unknown("The action interval has not reached its bounded quiet completion.");
  const equal = structurallyEqual(before.value, after.value);
  switch (predicate.relation) {
    case "changed": return verdict(equal ? "fail" : "pass", equal
      ? "The complete scoped value did not change during the declared action result."
      : "The complete scoped value changed within the correlated action result.");
    case "becomes": {
      const expected = captureBaselineReading({ scope, cursor: 0, complete: true, fresh: true }, predicate.equals);
      if (expected.availability !== "complete" || hasUnavailableValue(expected.value)) return unknown("The expected value is not complete, readable finite JSON.");
      if (!structurallyEqual(after.value, expected.value)) return verdict("fail", "The correlated result differs from the declared expectation.");
      if (structurallyEqual(before.value, expected.value)) return unknown("The expectation already held before the action; its continued presence does not prove a causal transition.");
      return verdict("pass", "The complete value transitioned to the declared expectation within the correlated action result.");
    }
    case "increased": case "decreased": {
      if (typeof before.value !== "number" || typeof after.value !== "number") return unknown("A numerical relative assertion requires two finite numerical readings.");
      const pass = predicate.relation === "increased" ? after.value > before.value : after.value < before.value;
      return verdict(pass ? "pass" : "fail", pass
        ? `The scoped numerical value ${predicate.relation} within the correlated action result.`
        : `The scoped numerical value did not ${predicate.relation === "increased" ? "increase" : "decrease"} within the correlated action result.`);
    }
    default: return unknown("The relative comparison is unsupported.");
  }
}
