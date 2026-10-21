import { randomUUID } from "node:crypto";
import { VerificationBridge, VerificationHttpError, type VerificationBridgeOptions, type VerificationSession } from "./bridge";
import { evaluatePredicate, type EvaluationContext } from "./predicates";
import { parseCommand, parsePredicate } from "./validation";
import { saveReport, getFlow, rebindFlow, boundedEvidence } from "./store";
import { boundReportContext } from "./report-context";
import { relativeTargets, relativeTargetKey, VERIFICATION_LIMITS as L, type Predicate,
  type Verdict, type VerificationReport, type VerificationCheckContext, type RetainedControlSource } from "./protocol";
import { FlowRepairReviews } from "./flow-repair";
import { parseFlowDiscovery, resolveFlowAnchor } from "./flow-anchors";
import { baselineScopeForTarget, type BaselineReading } from "./baseline";
import { saveCapturedSnapshot } from "./snapshot-store";
import type { AppCommand } from "./protocol";
import { evaluatePerformancePredicate } from "./performance";

export interface VerificationServiceOptions extends VerificationBridgeOptions { checkTimeoutMs?: number }

export function flowPassReason(steps: number): string {
  const scope = steps === 1 ? "1 step verified during its observed interval; it" : `${steps} steps verified during their observed intervals; each`;
  return `${scope} completed with no tracked requests pending and at least ${L.QUIET_MS}ms quiet.`;
}

export class VerificationService {
  readonly bridge: VerificationBridge;
  readonly repairs = new FlowRepairReviews();
  constructor(private readonly options: VerificationServiceOptions) { this.bridge = new VerificationBridge(options); }

  private async lock<T>(session: VerificationSession, work: () => Promise<T>): Promise<T> {
    if (session.busy) throw new VerificationHttpError(409, "An action or verification is already running for this application");
    session.busy = true;
    try { return await work(); } finally { session.busy = false; }
  }

  act(id: string, value: unknown) {
    const command = parseCommand(value);
    const session = this.bridge.get(id);
    return this.lock(session, async () => {
      const { unavailable: _unavailable, ...result } = await this.bridge.command(session, command);
      return result;
    });
  }

  captureSnapshot(id: string, name: unknown) {
    const session = this.bridge.get(id);
    return this.lock(session, async () => {
      const socket = session.ws; const generation = session.generation;
      if (!socket) throw new VerificationHttpError(409, "Connect the application before capturing a snapshot");
      const result = await this.bridge.command(session, { type: "semantic-tree" });
      if (!result.ok || this.bridge.sessions.get(id) !== session || !session.ws || session.ws !== socket || session.generation !== generation) throw new VerificationHttpError(409, result.error ?? "Application connection changed during snapshot capture");
      return saveCapturedSnapshot({ sessionId: session.id, runId: session.runId, origin: session.origin, name: this.bridge.sanitize(session, name).value, tree: result.result, connectionGeneration: generation, capturedAt: Date.now() });
    });
  }

  assert(id: string, value: unknown, since: number | undefined, name = "Application check") {
    const predicate = parsePredicate(value);
    const session = this.bridge.get(id);
    return this.lock(session, async () => {
      const result = await this.check(session, predicate, since ?? session.lastCommandCursor, session.generation);
      return this.report(session, name, null, result.verdict, [result.context]);
    });
  }

  proposeRepair(id: string, sessionId: string, step: number) {
    const flow = getFlow(id); const session = this.bridge.get(sessionId);
    if (session.origin !== flow.origin) throw new VerificationHttpError(409, "Flow origin does not match this application session");
    return this.lock(session, async () => {
      const generation = session.generation;
      let cssCount: number | undefined;
      const anchor = flow.steps[step]?.anchor;
      if (anchor?.kind === "css") {
        const css = await this.bridge.command(session, { type: "snapshot", selector: anchor.selector });
        const count = (css.result as { count?: unknown } | undefined)?.count;
        if (css.ok && !css.truncated && typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 10000) cssCount = count;
      }
      const response = await this.bridge.command(session, { type: "semantic-snapshot" });
      if (!response.ok || generation !== session.generation) throw new VerificationHttpError(409, "Current application discovery unavailable");
      const discovery = parseFlowDiscovery(response.result);
      if (response.truncated) {
        discovery.coverage.complete = false; discovery.coverage.truncated = true; discovery.countExact = false;
        if (discovery.coverage.reasons.length < 16 && !discovery.coverage.reasons.includes("transport-incomplete")) discovery.coverage.reasons.push("transport-incomplete");
      }
      return this.repairs.create(flow, step, sessionId, generation, discovery, cssCount);
    });
  }

  commitRepair(id: string, proposalId: string, body: unknown) {
    const { retained, candidate } = this.repairs.review(id, proposalId, body);
    const session = this.bridge.get(retained.sessionId);
    return this.lock(session, async () => {
      const flow = getFlow(id);
      if (flow.revision !== retained.view.revision || flow.origin !== session.origin || session.generation !== retained.generation) throw new VerificationHttpError(409, "Flow or application changed since review");
      const response = await this.bridge.command(session, { type: "semantic-snapshot" });
      if (!response.ok || response.truncated) throw new VerificationHttpError(409, "Current candidate discovery unavailable or incomplete");
      this.repairs.validateCurrent(retained, candidate, session.generation, response.result);
      const updated = rebindFlow(id, retained.view.revision, retained.view.step, candidate.anchor);
      this.repairs.cancel(id, proposalId);
      return updated;
    });
  }

  runFlow(id: string, sessionId: string) {
    const flow = getFlow(id);
    const session = this.bridge.get(sessionId);
    if (session.origin !== flow.origin) throw new VerificationHttpError(409, "Flow origin does not match this application session");
    return this.lock(session, async () => {
      const generation = session.generation;
      const evidence: Verdict["evidence"] = [];
      const checks: VerificationCheckContext[] = [];
      for (let index = 0; index < flow.steps.length; index++) {
        const step = flow.steps[index];
        let since = this.bridge.tick(session);
        let controlSource: RetainedControlSource | undefined;
        const started = Date.now();
        if (generation !== session.generation || !session.ws) {
          const verdict: Verdict = { status: "inconclusive", reason: "Application disconnected or changed document during the flow", evidence };
          checks.push(this.checkContext(session, step.predicate, verdict, since, generation, started, index + 1, false));
          return this.report(session, flow.name, flow.id, verdict, checks);
        }
        if (step.command) {
          const targets = relativeTargets(step.predicate);
          let command = targets.length && ["click", "causal-click"].includes(step.command.type)
            ? parseCommand({ type: "causal-click", selector: (step.command as { selector: string }).selector, targets }) : step.command;
          if (step.anchor?.kind === "semantic") {
            const discovery = await this.bridge.command(session, { type: "semantic-snapshot" });
            let resolved: ReturnType<typeof resolveFlowAnchor> = { reason: discovery.error ?? "Current anchor discovery unavailable", matches: 0 };
            try { if (discovery.ok && !discovery.truncated && generation === session.generation) resolved = resolveFlowAnchor(step.anchor, parseFlowDiscovery(discovery.result)); } catch { resolved.reason = "Current anchor discovery is malformed or private"; }
            if (!resolved.ref) {
              const verdict: Verdict = { status: "inconclusive", reason: `Step ${index + 1}: ${resolved.reason}. Review an explicit repair; no action dispatched.`, evidence };
              checks.push(this.checkContext(session, step.predicate, verdict, since, generation, started, index + 1, false));
              return this.report(session, flow.name, flow.id, verdict, checks);
            }
            command = { type: "ref-click", ref: resolved.ref };
          }
          const result = await this.bridge.command(session, command);
          since = result.cursor;
          controlSource = result.controlSource;
          if (!result.ok) {
            const verdict: Verdict = { status: "inconclusive", reason: `Step ${index + 1}: ${result.error ?? "Action was not acknowledged"}`, evidence };
            checks.push(this.checkContext(session, step.predicate, verdict, since, generation, started, index + 1, false, controlSource));
            return this.report(session, flow.name, flow.id, verdict, checks);
          }
        }
        const result = await this.check(session, step.predicate, since, generation, index + 1, controlSource);
        const { verdict } = result;
        checks.push(result.context);
        evidence.push(...verdict.evidence);
        if (verdict.status !== "pass") return this.report(session, flow.name, flow.id,
          { ...verdict, reason: `Step ${index + 1}: ${verdict.reason}`, evidence }, checks);
      }
      const performanceChecks = flow.steps.some(step => this.reads(step.predicate).some(read => read.type === "performance"));
      return this.report(session, flow.name, flow.id, { status: "pass", reason: performanceChecks
        ? `${flow.steps.length} declared steps met their checks. Native numeric checks describe selected lab populations; other checks retain their bounded quiet requirements.`
        : flowPassReason(flow.steps.length), evidence }, checks);
    });
  }

  private async check(session: VerificationSession, predicate: Predicate, since: number, generation: number, step = 1, controlSource?: RetainedControlSource): Promise<{ verdict: Verdict; context: VerificationCheckContext }> {
    const deadline = Date.now() + (this.options.checkTimeoutMs ?? L.CHECK_TIMEOUT_MS);
    const started = Date.now();
    let fresh = false;
    const source = controlSource ?? (session.lastControlSource?.commandCursor === since && session.lastControlSource.generation === generation
      && generation === session.generation && session.lastControlSource.actionId === session.currentActionId ? session.lastControlSource : undefined);
    const finish = (verdict: Verdict) => ({ verdict, context: this.checkContext(session, predicate, verdict, since, generation, started, step, fresh, source) });
    const actionId = session.currentActionId;
    let latest: Verdict = { status: "inconclusive", reason: "No fresh observations available", evidence: [] };
    const reads = this.reads(predicate);
    if (predicate.kind === "performance") {
      const response = await this.bridge.command(session, { type: "performance", phase: "capture" }, Math.max(1, deadline - Date.now()));
      fresh = response.ok && session.generation === generation && session.lastPerformance?.cursor === response.cursor;
      return finish(evaluatePerformancePredicate(predicate, session.lastPerformance?.snapshot, fresh));
    }
    // A fresh reply proves the document processed ready and flushed its earlier queued observations.
    // Hello alone cannot establish absence while a blocked page has not yet delivered captured errors.
    if (reads.length === 0) {
      const response = await this.bridge.command(session, { type: "snapshot" }, Math.max(1, deadline - Date.now()));
      fresh = response.ok || response.unavailable === true;
      if (!fresh) return finish({ status: "inconclusive", reason: response.error ?? "Fresh application acknowledgement unavailable", evidence: [] });
    }
    while (Date.now() < deadline) {
      if (!session.ws || session.generation !== generation) return finish({ status: "inconclusive", reason: "Application disconnected or changed document during verification", evidence: latest.evidence });
      for (const read of reads) {
        const response = await this.bridge.command(session, read, Math.max(1, deadline - Date.now()));
        if (!response.ok && !response.unavailable) return finish({ status: "inconclusive", reason: response.error ?? "Fresh application observation unavailable", evidence: latest.evidence });
        fresh = true;
      }
      if (!session.ws || session.generation !== generation) return finish({ status: "inconclusive", reason: "Application connection changed while collecting evidence", evidence: [] });
      const observed = this.bridge.observe(session, since);
      const settled = session.coverage.network && !session.pending && session.requests.size === 0 && Date.now() - Math.max(started, session.lastActivity) >= L.QUIET_MS;
      latest = evaluatePredicate(predicate, { events: observed.events, coverage: session.coverage, complete: observed.complete, settled, actionId,
        ...(reads.some(read => read.type === "performance") && session.lastPerformance?.generation === generation ? { performance: { snapshot: session.lastPerformance.snapshot, fresh: fresh && session.lastPerformance.cursor >= since } } : {}),
        relative: this.relativeContext(session, predicate, since, generation, observed.cursor, observed.complete, settled) });
      if (latest.status === "pass" && settled) return finish({ ...latest, reason: `${latest.reason} Verified during an observed interval with ${L.QUIET_MS}ms quiet and no tracked requests pending.` });
      // An atomic relative result is an immutable owned turn. Waiting cannot convert an
      // unchanged synchronous result into a later background or business completion.
      if (predicate.kind === "relative" && settled) return finish(latest);
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, L.POLL_MS)));
    }
    if (!session.ws || session.generation !== generation) return finish({ status: "inconclusive", reason: "Application disconnected before verification completed", evidence: latest.evidence });
    const observed = this.bridge.observe(session, since);
    const settled = session.coverage.network && !session.pending && session.requests.size === 0 && Date.now() - Math.max(started, session.lastActivity) >= L.QUIET_MS;
    if (!observed.complete || !settled) return finish({ status: "inconclusive", reason: "Capture was incomplete or did not reach the bounded quiet interval before timeout", evidence: boundedEvidence(observed.events) });
    return finish({ ...latest, reason: `${latest.reason} The check observed a bounded interval; it does not establish future behavior.` });
  }

  private checkContext(session: VerificationSession, predicate: Predicate, verdict: Verdict, since: number,
    generation: number, started: number, step: number, fresh: boolean, controlSource?: RetainedControlSource): VerificationCheckContext {
    const observed = this.bridge.observe(session, since);
    const current = !!session.ws && generation === session.generation;
    return { step, predicate, status: verdict.status, reason: verdict.reason, since, through: observed.cursor,
      generation, coverage: { ...session.coverage }, complete: fresh && current && observed.complete,
      dropped: observed.session.dropped,
      ...(controlSource?.commandCursor === since && controlSource.generation === generation ? { controlSource } : {}),
      ...(fresh && current && session.lastPerformance?.generation === generation && session.lastPerformance.cursor >= since && this.reads(predicate).some(read => read.type === "performance") ? { performance: session.lastPerformance } : {}),
      settled: fresh && current && session.coverage.network && !session.pending && session.requests.size === 0
        && Date.now() - Math.max(started, session.lastActivity) >= L.QUIET_MS,
      ...(relativeTargets(predicate).length ? { causal: this.retainedCausalContext(session, predicate, since, generation) } : {}) };
  }

  private matchingDispatch(session: VerificationSession, since: number, generation: number) {
    const captured = session.lastCausalResult;
    return captured && captured.startCursor === since && captured.generation === generation
      && generation === session.generation && captured.actionId === session.currentActionId ? captured : undefined;
  }

  private relativeContext(session: VerificationSession, predicate: Predicate, since: number, generation: number,
    through: number, complete: boolean, settled: boolean): EvaluationContext["relative"] {
    const dispatch = this.matchingDispatch(session, since, generation);
    return new Map(relativeTargets(predicate).map(target => {
      const key = relativeTargetKey(target);
      const pair = dispatch?.pairs.get(key);
      return [key, { scope: baselineScopeForTarget(session.id, generation, target), input: {
        before: pair?.before, after: pair?.after, attribution: pair?.attribution,
        action: { id: dispatch?.actionId ?? "", sessionId: session.id, generation,
          cursor: dispatch?.actionCursor ?? since, acknowledged: !!dispatch },
        through, complete, settled, coverage: { ...session.coverage },
      } }];
    }));
  }

  private retainedCausalContext(session: VerificationSession, predicate: Predicate, since: number, generation: number): NonNullable<VerificationCheckContext["causal"]> {
    const dispatch = this.matchingDispatch(session, since, generation);
    const readings = relativeTargets(predicate).map(target => {
      const pair = dispatch?.pairs.get(relativeTargetKey(target));
      const retain = (reading: BaselineReading | undefined) => reading
        ? { cursor: reading.cursor, availability: reading.availability, value: reading.value } : null;
      return { target, before: retain(pair?.before), after: retain(pair?.after) };
    });
    const captured = !!dispatch && relativeTargets(predicate).every(target => !!dispatch.pairs.get(relativeTargetKey(target))?.attribution);
    return { source: "sdk-reported", attribution: captured ? "captured" : "unavailable",
      ...(dispatch ? { actionId: dispatch.actionId } : {}), readings };
  }

  private reads(predicate: Predicate): AppCommand[] {
    if (predicate.kind === "performance") return [{ type: "performance", phase: "capture" }];
    if (predicate.kind === "state") return [{ type: "state", store: predicate.store }];
    if (predicate.kind === "element") return [{ type: "snapshot", selector: predicate.selector }];
    if (predicate.kind === "allOf" || predicate.kind === "anyOf") return predicate.predicates.flatMap((entry) => this.reads(entry));
    return [];
  }

  private report(session: VerificationSession, name: string, flowId: string | null, verdict: Verdict, checks: VerificationCheckContext[]): VerificationReport {
    const report = saveReport({ ...verdict, reason: String(this.bridge.sanitize(session, verdict.reason).value),
      evidence: verdict.evidence.map((event) => this.bridge.sanitizeEvent(session, event)),
      id: randomUUID(), sessionId: session.id, runId: session.runId, flowId,
      name: String(this.bridge.sanitize(session, name).value), createdAt: Date.now(),
      context: boundReportContext({ origin: session.origin, checks, quietMs: L.QUIET_MS, redacted: false, truncated: false },
        (value) => this.bridge.sanitize(session, value)) });
    this.options.broadcast("verification_report", report);
    return report;
  }

  close(): void { this.repairs.clear(); this.bridge.close(); }
}

export function createVerificationService(options: VerificationServiceOptions): VerificationService { return new VerificationService(options); }
