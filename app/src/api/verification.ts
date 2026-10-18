import { apiJson, jsonInit } from "./request";
import type { AppCommand, FlowStep, Observation, Predicate, SessionSummary, VerificationFlow, VerificationReport } from "../../../src/verification/protocol";
import type { PortableSnapshots, SavedSemanticSnapshot, SnapshotDiffResult } from "../../../src/verification/snapshot-contract";

export type { AppCommand, FlowStep, Observation, Predicate, RuntimeEvent, SessionSummary, VerificationFlow, VerificationReport, VerificationReportContext, VerificationStatus } from "../../../src/verification/protocol";
export type CreatedSession = SessionSummary & { token: string; sdkUrl: string; wsUrl: string };
export type CommandResult = { ok: boolean; cursor: number; result?: unknown; error?: string; truncated?: boolean };
import type { FlowRepairProposal } from "../../../src/verification/protocol";

const root = "/api/verification";
const sessionPath = (id: string) => `${root}/sessions/${encodeURIComponent(id)}`;

export const verificationApi = {
  sessions: () => apiJson<SessionSummary[]>(`${root}/sessions`),
  createSession: (origin: string, runId?: string) => apiJson<CreatedSession>(`${root}/sessions`, jsonInit("POST", { origin, runId })),
  disconnect: (id: string) => apiJson<{ ok: true }>(sessionPath(id), jsonInit("DELETE")),
  observe: (id: string) => apiJson<Observation>(`${sessionPath(id)}/events`),
  command: (id: string, command: AppCommand) => apiJson<CommandResult>(`${sessionPath(id)}/command`, jsonInit("POST", command)),
  assert: (id: string, predicate: Predicate, since?: number, name?: string) => apiJson<VerificationReport>(`${sessionPath(id)}/assert`, jsonInit("POST", { predicate, since, name })),
  reports: (runId?: string) => apiJson<VerificationReport[]>(`${root}/reports${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`),
  flows: () => apiJson<VerificationFlow[]>(`${root}/flows`),
  saveFlow: (name: string, origin: string, steps: FlowStep[]) => apiJson<VerificationFlow>(`${root}/flows`, jsonInit("POST", { name, origin, steps })),
  runFlow: (id: string, sessionId: string) => apiJson<VerificationReport>(`${root}/flows/${encodeURIComponent(id)}/run`, jsonInit("POST", { sessionId })),
  proposeRepair: (id: string, sessionId: string, step: number) => apiJson<FlowRepairProposal>(`${root}/flows/${encodeURIComponent(id)}/repair-proposals`, jsonInit("POST", { sessionId, step })),
  commitRepair: (id: string, proposalId: string, candidateId: string, revision: string) => apiJson<VerificationFlow>(`${root}/flows/${encodeURIComponent(id)}/repair-proposals/${encodeURIComponent(proposalId)}/commit`, jsonInit("POST", { candidateId, revision })),
  cancelRepair: (id: string, proposalId: string) => apiJson<{ ok: true }>(`${root}/flows/${encodeURIComponent(id)}/repair-proposals/${encodeURIComponent(proposalId)}`, jsonInit("DELETE")),
  deleteFlow: (id: string) => apiJson<{ ok: true }>(`${root}/flows/${encodeURIComponent(id)}`, jsonInit("DELETE")),
  snapshots: (runId?: string) => apiJson<SavedSemanticSnapshot[]>(`${root}/snapshots${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`),
  captureSnapshot: (id: string, name: string) => apiJson<SavedSemanticSnapshot>(`${sessionPath(id)}/snapshots`, jsonInit("POST", { name })),
  compareSnapshots: (beforeId: string, afterId: string) => apiJson<SnapshotDiffResult>(`${root}/snapshot-diff`, jsonInit("POST", { beforeId, afterId })),
  deleteSnapshot: (id: string) => apiJson<{ ok: true }>(`${root}/snapshots/${encodeURIComponent(id)}`, jsonInit("DELETE")),
  exportSnapshots: (ids: string[]) => apiJson<PortableSnapshots>(`${root}/snapshots/export`, jsonInit("POST", { ids })),
  importSnapshots: (artifact: unknown, runId?: string) => apiJson<SavedSemanticSnapshot[]>(`${root}/snapshots/import`, jsonInit("POST", { artifact, ...(runId ? { runId } : {}) })),
};
