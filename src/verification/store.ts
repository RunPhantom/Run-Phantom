import { randomUUID } from "node:crypto";
import { asc, desc, eq, count, inArray } from "drizzle-orm";
import { getDrizzleDb, getRunById } from "../db";
import { verification_flows, verification_reports } from "../db/schema";
import { redactForPersistence, sanitizeWithReport } from "./serialization";
import { parseFlowSteps } from "./validation";
import { VERIFICATION_LIMITS as L, type VerificationFlow, type VerificationReport, type RuntimeEvent } from "./protocol";
import { VerificationHttpError, parseAppOrigin } from "./bridge";
import { boundReportContext } from "./report-context";

export function boundedEvidence(events: RuntimeEvent[]): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  let bytes = 0;
  for (const event of events.slice(-L.MAX_EVIDENCE_EVENTS)) {
    const clean = redactForPersistence(event) as RuntimeEvent;
    const size = Buffer.byteLength(JSON.stringify(clean));
    if (bytes + size > L.MAX_EVIDENCE_BYTES) break;
    out.push(clean);
    bytes += size;
  }
  return out;
}

export function saveReport(report: VerificationReport): VerificationReport {
  const clean: VerificationReport = { ...report, runId: report.runId && getRunById(report.runId) ? report.runId : null,
    name: String(redactForPersistence(report.name)).slice(0, L.MAX_NAME_LENGTH),
    reason: String(redactForPersistence(report.reason)).slice(0, L.MAX_REASON_LENGTH), evidence: boundedEvidence(report.evidence),
    ...(report.context ? { context: boundReportContext(report.context) } : {}) };
  const db = getDrizzleDb();
  db.transaction((tx) => {
    tx.insert(verification_reports).values({ id: clean.id, session_id: clean.sessionId, run_id: clean.runId,
      flow_id: clean.flowId, name: clean.name, status: clean.status, reason: clean.reason,
      evidence: JSON.stringify(clean.evidence), context: clean.context ? JSON.stringify(clean.context) : null, created_at: clean.createdAt }).run();
    const excess = tx.select({ id: verification_reports.id }).from(verification_reports)
      .orderBy(desc(verification_reports.created_at), desc(verification_reports.id)).limit(L.MAX_REPORTS).offset(L.MAX_REPORTS).all();
    if (excess.length) tx.delete(verification_reports).where(inArray(verification_reports.id, excess.map((r) => r.id))).run();
  });
  return clean;
}

export function listReports(runId?: string): VerificationReport[] {
  const rows = getDrizzleDb().select().from(verification_reports)
    .where(runId ? eq(verification_reports.run_id, runId) : undefined)
    .orderBy(desc(verification_reports.created_at), desc(verification_reports.id)).limit(100).all();
  return rows.map((row) => ({ id: row.id, sessionId: row.session_id, runId: row.run_id, flowId: row.flow_id,
    name: row.name, status: row.status as VerificationReport["status"], reason: row.reason,
    evidence: JSON.parse(row.evidence) as RuntimeEvent[], createdAt: row.created_at,
    ...(row.context ? { context: JSON.parse(row.context) as VerificationReport["context"] } : {}) }));
}

export function saveFlow(name: string, origin: unknown, steps: unknown): VerificationFlow {
  const parsed = parseFlowSteps(steps);
  const flow: VerificationFlow = { id: randomUUID(), name: String(redactForPersistence(name)), origin: parseAppOrigin(origin),
    // Shared validation rejects live fill commands and credential-oriented predicates in saved flows.
    steps: parsed, createdAt: Date.now() };
  const safeSteps = sanitizeWithReport(parsed);
  if (safeSteps.redacted || safeSteps.truncation) throw new VerificationHttpError(400, "Flow contains sensitive or oversized expectations; narrow its steps before saving");
  const db = getDrizzleDb();
  db.transaction((tx) => {
    if ((tx.select({ n: count() }).from(verification_flows).get()?.n ?? 0) >= L.MAX_FLOWS) throw new VerificationHttpError(409, "Saved flow limit reached; delete a flow first");
    tx.insert(verification_flows).values({ id: flow.id, name: flow.name, origin: flow.origin, steps: JSON.stringify(flow.steps), created_at: flow.createdAt }).run();
  });
  return flow;
}

export function listFlows(): VerificationFlow[] {
  return getDrizzleDb().select().from(verification_flows).orderBy(asc(verification_flows.created_at)).all()
    .map((row) => ({ id: row.id, name: row.name, origin: row.origin, steps: JSON.parse(row.steps), createdAt: row.created_at }));
}

export function getFlow(id: string): VerificationFlow {
  const flow = listFlows().find((entry) => entry.id === id);
  if (!flow) throw new VerificationHttpError(404, "Verification flow not found");
  return { ...flow, steps: parseFlowSteps(flow.steps) };
}

export function deleteFlow(id: string): void {
  getDrizzleDb().delete(verification_flows).where(eq(verification_flows.id, id)).run();
}
