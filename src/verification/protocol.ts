/** Shared browser/daemon contract for Run Phantom application verification. */
export const PROTOCOL_VERSION = 1 as const;
export const CAUSAL_PROTOCOL_VERSION = 2 as const;
export const CAUSAL_CAPABILITY = "causal-readings" as const;
export const SEMANTIC_PROTOCOL_VERSION = 3 as const;
export const SEMANTIC_CAPABILITY = "semantic-refs" as const;
export const BUSINESS_PROTOCOL_VERSION = 4 as const;
export const BUSINESS_CAPABILITY = "business-response-evidence" as const;
export const BUSINESS_LIMITS = { RAW_BYTES: 32768, BODY_BYTES: 8192, READERS: 4, CHUNKS: 128, DEADLINE_MS: 1500 } as const;
export const SOURCE_PROTOCOL_VERSION = 4 as const;
export const SOURCE_CAPABILITY = "control-source" as const;
export const TREE_PROTOCOL_VERSION = 5 as const;
export const TREE_CAPABILITY = "semantic-tree" as const;
export const PERFORMANCE_PROTOCOL_VERSION = 6 as const;
export const PERFORMANCE_CAPABILITY = "performance-evidence" as const;
import type { PerformancePredicate, RetainedPerformanceEvidence } from "./performance";
export const SEMANTIC_REF_PATTERN = /^rpref_[0-9a-f]{32}$/;
export type VerificationCapability = typeof BUSINESS_CAPABILITY | typeof CAUSAL_CAPABILITY | typeof SEMANTIC_CAPABILITY | typeof SOURCE_CAPABILITY | typeof TREE_CAPABILITY | typeof PERFORMANCE_CAPABILITY;

export type ControlSourceObservation = {
  source: "sdk-reported"; framework: "react"; status: "captured";
  mechanism: "dev-stamp" | "react-debug-source"; scope: "control" | "ancestor";
  file: string; line: number; column?: number; component?: string;
} | {
  source: "sdk-reported"; framework: "react"; status: "unavailable";
  reason: "not-react" | "source-unavailable" | "unsafe-source" | "probe-limit" | "probe-error" | "redacted";
};
export interface RetainedControlSource {
  actionId: string; commandCursor: number; cursor: number; generation: number;
  capture: "before-dispatch"; observation: ControlSourceObservation;
}

export type SemanticQuery =
  | { kind: "role"; role: string; name?: string; exact?: boolean }
  | { kind: "name"; name: string; exact?: boolean }
  | { kind: "label"; label: string; exact?: boolean }
  | { kind: "test-id"; testId: string };

export interface SemanticCoverage {
  scope: "visible-observable-dom";
  complete: boolean;
  visitedNodes: number;
  openShadowRoots: number;
  sameOriginFrames: number;
  inaccessibleFrames: number;
  closedShadowRoots: "unobservable";
  hiddenSubtrees: number;
  privateSubtrees: number;
  truncated: boolean;
  reasons: string[];
  unread: Array<{ tag: string; reason: string }>;
  unreadOverflow?: true;
}
export interface SemanticSummary { ref?: string; tag: string; role: string; name: string; label: string; testId: string; depth: number; disabled: boolean; readonly: boolean; truncated?: true; controlSource?: ControlSourceObservation }
export interface SemanticResult {
  source: "sdk-reported";
  nameModel: "partial-aria";
  documentGeneration: string;
  query?: SemanticQuery;
  status?: "unique" | "ambiguous" | "not-found" | "inconclusive";
  ref?: string;
  count: number;
  countExact: boolean;
  elements: SemanticSummary[];
  coverage: SemanticCoverage;
}

export function normalizeSemanticText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}
export type SemanticCommand =
  | { type: "find"; query: SemanticQuery }
  | { type: "semantic-snapshot" }
  | { type: "ref-click"; ref: string }
  | { type: "ref-fill"; ref: string; value: string };

export const VERIFICATION_LIMITS = {
  MAX_SESSIONS: 16,
  MAX_PENDING_PER_SESSION: 1,
  MAX_FRAME_BYTES: 128 * 1024,
  MAX_EVENT_BYTES: 16 * 1024,
  MAX_EVENTS: 1000,
  MAX_BUFFER_BYTES: 1024 * 1024,
  MAX_EVENT_AGE_MS: 60_000,
  CREDENTIAL_TTL_MS: 60 * 60 * 1000,
  HELLO_TIMEOUT_MS: 3000,
  COMMAND_TIMEOUT_MS: 5000,
  CHECK_TIMEOUT_MS: 5000,
  QUIET_MS: 300,
  POLL_MS: 250,
  MAX_STEPS: 20,
  MAX_REPORTS: 1000,
  MAX_FLOWS: 100,
  MAX_EVIDENCE_EVENTS: 30,
  MAX_EVIDENCE_BYTES: 64 * 1024,
  MAX_CONTEXT_BYTES: 64 * 1024,
  MAX_REASON_LENGTH: 1000,
  MAX_SELECTOR_LENGTH: 1024,
  MAX_TEXT_LENGTH: 4096,
  MAX_NAME_LENGTH: 128,
  MAX_PREDICATE_DEPTH: 6,
  MAX_PREDICATE_NODES: 50,
  MAX_BASELINE_TARGETS: 20,
} as const;

export type VerificationStatus = "pass" | "fail" | "inconclusive";
export interface RuntimeEvent {
  t: number;
  type: string;
  data: Record<string, unknown>;
  actionId?: string;
  truncated?: boolean;
}
export interface Coverage {
  network: boolean;
  console: boolean;
  dom: boolean;
  state: boolean;
  signal: boolean;
  route: boolean;
}
export type RelativeTarget = { kind: "state"; store: string; path: string } | { kind: "element"; selector: string };
export type RelativePredicate = { kind: "relative"; target: RelativeTarget } & (
  | { relation: "changed" | "increased" | "decreased" }
  | { relation: "becomes"; equals: unknown }
);
export function relativeTargetKey(target: RelativeTarget): string {
  return JSON.stringify(target.kind === "state" ? [target.kind, target.store, target.path] : [target.kind, target.selector]);
}
export function relativeTargets(predicate: Predicate): RelativeTarget[] {
  if (predicate.kind === "relative") return [predicate.target];
  if (predicate.kind !== "allOf" && predicate.kind !== "anyOf") return [];
  return [...new Map(predicate.predicates.flatMap(relativeTargets).map((target) => [relativeTargetKey(target), target])).values()];
}
export type AppCommand =
  | { type: "semantic-tree" }
  | { type: "snapshot"; selector?: string }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "state"; store: string }
  | { type: "causal-click"; selector: string; targets: RelativeTarget[] }
  | { type: "performance"; phase: "begin" | "capture" }
  | SemanticCommand;
export type BusinessWitness =
  | { kind: "state"; store: string; operationPath: string; path: string }
  | { kind: "signal"; name: string; operationPath: string; path: string };
export interface BusinessPredicate {
  kind: "business-response";
  urlContains: string;
  method?: string;
  operationId: string;
  operationPath: string;
  path: string;
  equals: unknown;
  phase: "response" | "acceptance" | "final";
  witness?: BusinessWitness;
}
export type BodyState = "pending" | "complete" | "truncated" | "timeout" | "aborted" | "opaque" | "unsupported" | "unavailable";
export type BodyFormat = "json" | "sse" | "ndjson" | "none";
export type Predicate =
  | { kind: "network"; urlContains: string; method?: string; status?: number }
  | { kind: "console"; level: "error" | "warn"; absent: boolean }
  | { kind: "signal"; name: string }
  | { kind: "state"; store: string; path: string; equals: unknown }
  | { kind: "element"; selector: string; state: "present" | "absent" }
  | { kind: "allOf" | "anyOf"; predicates: Predicate[] }
  | PerformancePredicate
  | BusinessPredicate
  | RelativePredicate;
export type FlowAnchor = { kind: "css"; selector: string } | {
  kind: "semantic"; query: SemanticQuery;
  instance: Pick<SemanticSummary, "tag" | "role" | "name" | "label" | "testId">;
  source?: ControlSourceObservation;
};
export interface FlowStep { command?: AppCommand; predicate: Predicate; anchor?: FlowAnchor }
export interface FlowDocument { version: 2; steps: FlowStep[] }
export interface VerificationFlow {
  version: 2;
  revision: string;
  id: string;
  name: string;
  origin: string;
  steps: FlowStep[];
  createdAt: number;
}
export interface FlowRepairCandidate {
  id: string; anchor: Extract<FlowAnchor, { kind: "semantic" }>; selectable: boolean;
  sourceMatch: "same" | "changed" | "unavailable" | "unrecorded"; reason: string;
}
export interface FlowRepairProposal {
  id: string; flowId: string; revision: string; step: number; oldAnchor: FlowAnchor;
  oldMatch: { matches: number | null; reason: string };
  candidates: FlowRepairCandidate[]; coverage: SemanticCoverage;
  ambiguous: boolean; sourceIncomplete: boolean; expiresAt: number;
}
export interface Verdict { status: VerificationStatus; reason: string; evidence: RuntimeEvent[] }
export interface VerificationCheckContext {
  step: number;
  predicate: unknown;
  status: VerificationStatus;
  reason: string;
  since: number;
  through: number;
  generation: number;
  coverage: Coverage;
  complete: boolean;
  dropped: number;
  settled: boolean;
  causal?: RetainedCausalContext;
  controlSource?: RetainedControlSource;
  controlSourceOmitted?: "context-limit";
  performance?: RetainedPerformanceEvidence;
  performanceOmitted?: "context-limit" | "invalid-stored-evidence";
}
export interface RetainedReading { cursor: number; availability: "complete" | "partial" | "unavailable"; value: unknown }
export interface RetainedCausalContext {
  source: "sdk-reported";
  attribution: "captured" | "unavailable";
  actionId?: string;
  omitted?: true;
  readings: Array<{ target: RelativeTarget; before: RetainedReading | null; after: RetainedReading | null }>;
}
export interface VerificationReportContext {
  origin: string;
  checks: VerificationCheckContext[];
  quietMs: number;
  redacted: boolean;
  truncated: boolean;
  /** Daemon-generated execution observation; never a live page authority. */
  execution?: import("./browser-types").ExecutionContext;
  executionOmitted?: "context-limit" | "invalid";
}
export interface VerificationReport extends Verdict {
  id: string;
  sessionId: string;
  runId: string | null;
  flowId: string | null;
  name: string;
  createdAt: number;
  context?: VerificationReportContext;
}
/** Current workspace diagnostics remain advisory and cannot change a saved verdict. */
export interface ChangeWorkspaceOffer { workspaceId: string; label: string; expiresAt: number }
export interface FailureHandoff {
  reportId: string;
  name: string;
  status: VerificationStatus;
  reason: string;
  origin: string | null;
  reproduction: "partial";
  reproductionNote: string;
  checks: Array<{ step: number; predicate: unknown; status: VerificationStatus; actual: string;
    since: number; through: number; generation: number; complete: boolean; dropped: number; settled: boolean;
    coverage: Coverage; controlSource?: RetainedControlSource; controlSourceOmitted?: "context-limit"; causal?: RetainedCausalContext }>;
  checksOmitted: number;
  redacted: boolean;
  truncated: boolean;
}
export interface VerificationChangeContext {
  version: 1;
  observedAt: number;
  head: string | null;
  testedRevision: null;
  fingerprint: string | null;
  fingerprintCoverage: "metadata-only";
  complete: boolean;
  reasons: string[];
  withheldPaths: number;
  omittedRows: number;
  changes: Array<{ path: string; previousPath?: string; index: string; worktree: string; binary: boolean | null;
    added: number | null; deleted: number | null; content: "unavailable"; bytes?: number; modifiedAt?: number }>;
  relatedTests: Array<{ path: string; reason: "filename"; advisory: true }>;
  suggestions: Array<{ kind: "happy-path" | "persistence" | "negative-path"; advisory: true; text: string }>;
  handoff: FailureHandoff;
}
export interface SessionSummary {
  id: string;
  origin: string;
  runId: string | null;
  connected: boolean;
  createdAt: number;
  coverage: Coverage;
  cursor: number;
  dropped: number;
  capabilities?: VerificationCapability[];
}
export interface Observation {
  session: SessionSummary;
  events: RuntimeEvent[];
  cursor: number;
  complete: boolean;
}
export type BrowserMessage =
  | { type: "hello"; version: typeof PROTOCOL_VERSION; token: string; coverage: Coverage }
  | { type: "hello"; version: typeof CAUSAL_PROTOCOL_VERSION; token: string; coverage: Coverage; capabilities: Array<typeof CAUSAL_CAPABILITY> }
  | { type: "hello"; version: typeof SEMANTIC_PROTOCOL_VERSION; token: string; coverage: Coverage; capabilities: VerificationCapability[] }
  | { type: "hello"; version: typeof SOURCE_PROTOCOL_VERSION; token: string; coverage: Coverage; capabilities: VerificationCapability[] }
  | { type: "hello"; version: typeof TREE_PROTOCOL_VERSION; token: string; coverage: Coverage; capabilities: VerificationCapability[] }
  | { type: "hello"; version: typeof PERFORMANCE_PROTOCOL_VERSION; token: string; coverage: Coverage; capabilities: VerificationCapability[] }
  | { type: "event"; event: Omit<RuntimeEvent, "t"> }
  | { type: "result"; id: string; ok: boolean; result?: unknown; error?: string; truncated?: boolean };
export type DaemonMessage =
  | { type: "ready" }
  | { type: "command"; id: string; command: AppCommand };
export interface PredicateContext {
  capabilities?: readonly VerificationCapability[];
  events: RuntimeEvent[];
  coverage: Coverage;
  complete: boolean;
  settled: boolean;
  actionId?: string;
}
