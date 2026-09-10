/** Shared browser/daemon contract for Run Phantom application verification. */
export const PROTOCOL_VERSION = 1 as const;

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
export type AppCommand =
  | { type: "snapshot"; selector?: string }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "state"; store: string };
export type Predicate =
  | { kind: "network"; urlContains: string; method?: string; status?: number }
  | { kind: "console"; level: "error" | "warn"; absent: boolean }
  | { kind: "signal"; name: string }
  | { kind: "state"; store: string; path: string; equals: unknown }
  | { kind: "element"; selector: string; state: "present" | "absent" }
  | { kind: "allOf" | "anyOf"; predicates: Predicate[] };
export interface FlowStep { command?: AppCommand; predicate: Predicate }
export interface VerificationFlow {
  id: string;
  name: string;
  origin: string;
  steps: FlowStep[];
  createdAt: number;
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
}
export interface VerificationReportContext {
  origin: string;
  checks: VerificationCheckContext[];
  quietMs: number;
  redacted: boolean;
  truncated: boolean;
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
export interface SessionSummary {
  id: string;
  origin: string;
  runId: string | null;
  connected: boolean;
  createdAt: number;
  coverage: Coverage;
  cursor: number;
  dropped: number;
}
export interface Observation {
  session: SessionSummary;
  events: RuntimeEvent[];
  cursor: number;
  complete: boolean;
}
export type BrowserMessage =
  | { type: "hello"; version: typeof PROTOCOL_VERSION; token: string; coverage: Coverage }
  | { type: "event"; event: Omit<RuntimeEvent, "t"> }
  | { type: "result"; id: string; ok: boolean; result?: unknown; error?: string; truncated?: boolean };
export type DaemonMessage =
  | { type: "ready" }
  | { type: "command"; id: string; command: AppCommand };
export interface PredicateContext {
  events: RuntimeEvent[];
  coverage: Coverage;
  complete: boolean;
  settled: boolean;
  actionId?: string;
}
