import { randomUUID } from "node:crypto";
import { anchorForCandidate, flowObject, parseFlowDiscovery, resolveFlowAnchor, sourceMatch } from "./flow-anchors";
import { relativeTargets } from "./protocol";
import type { FlowRepairCandidate, FlowRepairProposal, VerificationFlow } from "./protocol";
import { VerificationHttpError } from "./bridge";

export type { FlowRepairCandidate, FlowRepairProposal } from "./protocol";
interface RetainedProposal {
  view: FlowRepairProposal; sessionId: string; generation: number; documentGeneration: string;
  refs: Map<string, string>;
}
const TTL = 60_000;
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

/** Private bounded review leases. No proposal can dispatch a browser action. */
export class FlowRepairReviews {
  private readonly proposals = new Map<string, RetainedProposal>();
  private prune(): void { for (const [id, proposal] of this.proposals) if (proposal.view.expiresAt <= Date.now()) this.proposals.delete(id); }
  create(flow: VerificationFlow, stepIndex: number, sessionId: string, generation: number, raw: unknown, cssCount?: number): FlowRepairProposal {
    this.prune();
    if (this.proposals.size >= 100) throw new VerificationHttpError(409, "Repair proposal limit reached; cancel or wait for an existing proposal");
    if (!Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= flow.steps.length) throw new VerificationHttpError(400, "Invalid repair step");
    const step = flow.steps[stepIndex];
    if (!step.anchor || step.command?.type !== "click" || relativeTargets(step.predicate).length) throw new VerificationHttpError(400, "Review repair supports saved click steps without relative CSS baselines");
    const data = parseFlowDiscovery(raw);
    const refs = new Map<string, string>();
    const candidates = data.elements.filter(item => item.role && !["heading", "generic", "main", "navigation", "status"].includes(item.role)).slice(0, 100).map(item => {
      const anchor = anchorForCandidate(item); const resolution = resolveFlowAnchor(anchor, data); const id = randomUUID();
      if (resolution.ref) refs.set(id, resolution.ref);
      return { id, anchor, selectable: !!resolution.ref, sourceMatch: sourceMatch(step.anchor!, item), reason: resolution.reason };
    });
    const view: FlowRepairProposal = { id: randomUUID(), flowId: flow.id, revision: flow.revision, step: stepIndex,
      oldAnchor: step.anchor, oldMatch: step.anchor.kind === "semantic" ? resolveFlowAnchor(step.anchor, data) : {
        matches: cssCount ?? null, reason: cssCount === undefined ? "Original CSS match unavailable" : "Original CSS matches in the top document; frame and shadow coverage is separate" }, candidates, coverage: data.coverage,
      ambiguous: candidates.some(candidate => candidate.reason.includes("ambiguous")),
      sourceIncomplete: candidates.some(candidate => !candidate.anchor.source), expiresAt: Date.now() + TTL };
    this.proposals.set(view.id, { view: structuredClone(view), sessionId, generation, documentGeneration: data.documentGeneration, refs });
    return view;
  }
  review(flowId: string, proposalId: string, body: unknown): { retained: RetainedProposal; candidate: FlowRepairCandidate } {
    this.prune();
    if (!uuid(proposalId)) throw new VerificationHttpError(400, "Invalid repair proposal identity");
    const raw = flowObject(body, ["candidateId", "revision"], "reviewed repair selection");
    if (!uuid(raw.candidateId) || typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.revision)) throw new VerificationHttpError(400, "Invalid repair selection or revision");
    const retained = this.proposals.get(proposalId);
    if (!retained || retained.view.flowId !== flowId) throw new VerificationHttpError(404, "Repair proposal expired or unavailable; review a new proposal");
    if (raw.revision !== retained.view.revision) throw new VerificationHttpError(409, "Repair revision does not match the reviewed proposal");
    const candidate = retained.view.candidates.find(item => item.id === raw.candidateId);
    if (!candidate?.selectable) throw new VerificationHttpError(409, "Select one complete unambiguous candidate before committing");
    return { retained, candidate };
  }
  validateCurrent(retained: RetainedProposal, candidate: FlowRepairCandidate, generation: number, raw: unknown): void {
    if (this.proposals.get(retained.view.id) !== retained || retained.view.expiresAt <= Date.now()) throw new VerificationHttpError(409, "Repair proposal canceled, expired or unavailable; review a new proposal");
    const data = parseFlowDiscovery(raw);
    const resolution = resolveFlowAnchor(candidate.anchor, data);
    if (generation !== retained.generation || data.documentGeneration !== retained.documentGeneration || !resolution.ref || resolution.ref !== retained.refs.get(candidate.id)) throw new VerificationHttpError(409, "Application or candidate changed since review; request a new repair proposal");
  }
  cancel(flowId: string, proposalId: string): void {
    const current = this.proposals.get(proposalId);
    if (current?.view.flowId === flowId) this.proposals.delete(proposalId);
  }
  clear(): void { this.proposals.clear(); }
}
