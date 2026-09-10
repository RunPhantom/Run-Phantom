import { randomUUID } from "node:crypto";
import { VerificationBridge, VerificationHttpError, type VerificationBridgeOptions, type VerificationSession } from "./bridge";
import { evaluatePredicate } from "./predicates";
import { parseCommand, parsePredicate } from "./validation";
import { saveReport, getFlow, boundedEvidence } from "./store";
import { boundReportContext } from "./report-context";
import { VERIFICATION_LIMITS as L, type Predicate, type Verdict, type VerificationReport, type VerificationCheckContext } from "./protocol";

export interface VerificationServiceOptions extends VerificationBridgeOptions { checkTimeoutMs?: number }

export class VerificationService {
  readonly bridge: VerificationBridge;
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

  assert(id: string, value: unknown, since: number | undefined, name = "Application check") {
    const predicate = parsePredicate(value);
    const session = this.bridge.get(id);
    return this.lock(session, async () => {
      const result = await this.check(session, predicate, since ?? session.lastCommandCursor, session.generation);
      return this.report(session, name, null, result.verdict, [result.context]);
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
        const started = Date.now();
        if (generation !== session.generation || !session.ws) {
          const verdict: Verdict = { status: "inconclusive", reason: "Application disconnected or changed document during the flow", evidence };
          checks.push(this.checkContext(session, step.predicate, verdict, since, generation, started, index + 1, false));
          return this.report(session, flow.name, flow.id, verdict, checks);
        }
        if (step.command) {
          const result = await this.bridge.command(session, step.command);
          since = result.cursor;
          if (!result.ok) {
            const verdict: Verdict = { status: "inconclusive", reason: `Step ${index + 1}: ${result.error ?? "Action was not acknowledged"}`, evidence };
            checks.push(this.checkContext(session, step.predicate, verdict, since, generation, started, index + 1, false));
            return this.report(session, flow.name, flow.id, verdict, checks);
          }
        }
        const result = await this.check(session, step.predicate, since, generation, index + 1);
        const { verdict } = result;
        checks.push(result.context);
        evidence.push(...verdict.evidence);
        if (verdict.status !== "pass") return this.report(session, flow.name, flow.id,
          { ...verdict, reason: `Step ${index + 1}: ${verdict.reason}`, evidence }, checks);
      }
      return this.report(session, flow.name, flow.id, { status: "pass", reason: `${flow.steps.length} steps verified during their observed intervals; each completed with no tracked requests pending and at least ${L.QUIET_MS}ms quiet.`, evidence }, checks);
    });
  }

  private async check(session: VerificationSession, predicate: Predicate, since: number, generation: number, step = 1): Promise<{ verdict: Verdict; context: VerificationCheckContext }> {
    const deadline = Date.now() + (this.options.checkTimeoutMs ?? L.CHECK_TIMEOUT_MS);
    const started = Date.now();
    let fresh = false;
    const finish = (verdict: Verdict) => ({ verdict, context: this.checkContext(session, predicate, verdict, since, generation, started, step, fresh) });
    const actionId = session.currentActionId;
    let latest: Verdict = { status: "inconclusive", reason: "No fresh observations available", evidence: [] };
    const reads = this.reads(predicate);
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
      latest = evaluatePredicate(predicate, { events: observed.events, coverage: session.coverage, complete: observed.complete, settled, actionId });
      if (latest.status === "pass" && settled) return finish({ ...latest, reason: `${latest.reason} Verified during an observed interval with ${L.QUIET_MS}ms quiet and no tracked requests pending.` });
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
    generation: number, started: number, step: number, fresh: boolean): VerificationCheckContext {
    const observed = this.bridge.observe(session, since);
    const current = !!session.ws && generation === session.generation;
    return { step, predicate, status: verdict.status, reason: verdict.reason, since, through: observed.cursor,
      generation, coverage: { ...session.coverage }, complete: fresh && current && observed.complete,
      dropped: observed.session.dropped,
      settled: fresh && current && session.coverage.network && !session.pending && session.requests.size === 0
        && Date.now() - Math.max(started, session.lastActivity) >= L.QUIET_MS };
  }

  private reads(predicate: Predicate): Array<{ type: "snapshot"; selector: string } | { type: "state"; store: string }> {
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

  close(): void { this.bridge.close(); }
}

export function createVerificationService(options: VerificationServiceOptions): VerificationService { return new VerificationService(options); }
