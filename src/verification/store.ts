import { randomUUID, createHash } from "node:crypto";
import { and, asc, desc, eq, ne, count, inArray, notInArray } from "drizzle-orm";
import { getDrizzleDb, getRunById } from "../db";
import { verification_flows, verification_reports } from "../db/schema";
import { redactForPersistence, sanitizeWithReport } from "./serialization";
import { decodeFlowDocument } from "./flow-anchors";
import { VERIFICATION_LIMITS as L, type VerificationFlow, type VerificationReport, type RuntimeEvent } from "./protocol";
import { VerificationHttpError, parseAppOrigin } from "./bridge";
import { boundReportContext, reopenExecutionContext, revalidatePerformanceContext } from "./report-context";
import { activeLocalEvidenceAttachmentIds } from "../evaluations/evidence-inventory";

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
    const excessCount = (tx.select({ n: count() }).from(verification_reports).get()?.n ?? 0) - L.MAX_REPORTS;
    if (excessCount > 0) {
      const protectedIds = [...activeLocalEvidenceAttachmentIds(db.$client, "check")];
      const excess = tx.select({ id: verification_reports.id }).from(verification_reports)
        .where(and(ne(verification_reports.id, clean.id), protectedIds.length ? notInArray(verification_reports.id, protectedIds) : undefined))
        .orderBy(asc(verification_reports.created_at), asc(verification_reports.id)).limit(excessCount).all();
      if (excess.length < excessCount) throw new VerificationHttpError(409, "Report retention is full while evidence imports are active");
      tx.delete(verification_reports).where(inArray(verification_reports.id, excess.map((r) => r.id))).run();
    }
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
    ...(row.context ? { context: reopenExecutionContext(revalidatePerformanceContext(JSON.parse(row.context) as NonNullable<VerificationReport["context"]>)) } : {}) }));
}

export function saveFlow(name: string, origin: unknown, steps: unknown): VerificationFlow {
  const document = decodeFlowDocument(steps);
  const parsed = document.steps;
  const flow: VerificationFlow = { version: 2, revision: "", id: randomUUID(), name: String(redactForPersistence(name)), origin: parseAppOrigin(origin),
    // Shared validation rejects live fill commands and credential-oriented predicates in saved flows.
    steps: parsed, createdAt: Date.now() };
  const safeSteps = sanitizeWithReport(parsed);
  if (safeSteps.redacted || safeSteps.truncation) throw new VerificationHttpError(400, "Flow contains sensitive or oversized expectations; narrow its steps before saving");
  const db = getDrizzleDb();
  db.transaction((tx) => {
    if ((tx.select({ n: count() }).from(verification_flows).get()?.n ?? 0) >= L.MAX_FLOWS) throw new VerificationHttpError(409, "Saved flow limit reached; delete a flow first");
    tx.insert(verification_flows).values({ id: flow.id, name: flow.name, origin: flow.origin, steps: JSON.stringify(document), created_at: flow.createdAt }).run();
  });
  return getFlow(flow.id);
}

export function listFlows(): VerificationFlow[] {
  return getDrizzleDb().select().from(verification_flows).orderBy(asc(verification_flows.created_at)).all()
    .map(flowFromRow);
}

export function getFlow(id: string): VerificationFlow {
  const flow = listFlows().find((entry) => entry.id === id);
  if (!flow) throw new VerificationHttpError(404, "Verification flow not found");
  return flow;
}

export function deleteFlow(id: string): void {
  getDrizzleDb().delete(verification_flows).where(eq(verification_flows.id, id)).run();
}

function flowFromRow(row: typeof verification_flows.$inferSelect): VerificationFlow {
  const document = decodeFlowDocument(JSON.parse(row.steps));
  return { id: row.id, name: row.name, origin: row.origin, createdAt: row.created_at, ...document,
    revision: createHash("sha256").update(JSON.stringify([row.id, row.name, row.origin, row.steps, row.created_at])).digest("hex") };
}

/** CAS compares the original serialized bytes inside the existing storage transaction. */
export function rebindFlow(id: string, revision: string, stepIndex: number, anchor: unknown): VerificationFlow {
  const db = getDrizzleDb();
  db.transaction(tx => {
    const row = tx.select().from(verification_flows).where(eq(verification_flows.id, id)).get();
    if (!row) throw new VerificationHttpError(404, "Verification flow not found");
    const flow = flowFromRow(row);
    if (flow.revision !== revision) throw new VerificationHttpError(409, "Flow changed since this repair was proposed; review a new proposal");
    if (!Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= flow.steps.length) throw new VerificationHttpError(400, "Invalid flow step");
    const steps = flow.steps.map((step, index) => index === stepIndex ? { ...step, anchor } : step);
    const document = decodeFlowDocument({ version: 2, steps });
    const safe = sanitizeWithReport(document);
    if (safe.redacted || safe.truncation) throw new VerificationHttpError(400, "Repaired flow contains private or oversized metadata");
    const changed = tx.update(verification_flows).set({ steps: JSON.stringify(document) }).where(and(eq(verification_flows.id, id), eq(verification_flows.steps, row.steps))).returning({ id: verification_flows.id }).get();
    if (!changed) throw new VerificationHttpError(409, "Concurrent flow repair conflict");
  });
  return getFlow(id);
}
