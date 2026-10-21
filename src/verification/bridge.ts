import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { isAllowedRemoteAddress, hostnameOnly } from "../local-access";
import { getRunById } from "../db";
import { parseBrowserMessage, validateOrigin, parseFlowSteps } from "./validation";
import { sanitizeWithReport } from "./serialization";
import { isSensitiveKey } from "./redaction";
import { RingBuffer } from "./ring-buffer";
import { CAUSAL_CAPABILITY, BUSINESS_CAPABILITY, PROTOCOL_VERSION, SEMANTIC_CAPABILITY, SOURCE_CAPABILITY, TREE_CAPABILITY, relativeTargetKey, VERIFICATION_LIMITS as L,
  type AppCommand, type Coverage, type RelativeTarget, type RuntimeEvent, type SessionSummary, type VerificationCapability, type RetainedControlSource } from "./protocol";
import { sanitizeControlSource } from "./build/source";
import { baselineScopeForTarget, captureBaselineReading, captureCausalAttribution, type BaselineReading, type CausalAttribution } from "./baseline";
import { parseSemanticTree, sanitizeSemanticTree, treeIncomplete } from "./snapshot-contract";
import { PERFORMANCE_CAPABILITY } from "./protocol";
import { parsePerformanceSnapshot, scrubPerformanceMetadata, type RetainedPerformanceEvidence, type PerformanceSnapshot } from "./performance";

export class VerificationHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const parseAppOrigin = validateOrigin;

const emptyCoverage = (): Coverage => ({ network: false, console: false, dom: false, state: false, signal: false, route: false });
type CommandResult = { ok: boolean; cursor: number; result?: unknown; error?: string; truncated?: boolean; unavailable?: boolean; controlSource?: RetainedControlSource };
interface Pending {
  id: string;
  command: AppCommand;
  cursor: number;
  resolve(result: CommandResult): void;
  timer: ReturnType<typeof setTimeout>;
  boundary: boolean;
  controlSource?: RetainedControlSource;
  actionCursor?: number;
  before?: Map<string, BaselineReading>;
  after?: Map<string, BaselineReading>;
}
export interface CausalReadingPair {
  readonly target: RelativeTarget;
  readonly before: BaselineReading;
  readonly after: BaselineReading;
  readonly attribution?: CausalAttribution;
}
export interface CapturedCausalDispatch {
  readonly actionId: string;
  readonly actionCursor: number;
  readonly startCursor: number;
  readonly generation: number;
  readonly pairs: ReadonlyMap<string, CausalReadingPair>;
}
export interface VerificationSession {
  id: string;
  origin: string;
  runId: string | null;
  token: string;
  createdAt: number;
  expires: ReturnType<typeof setTimeout>;
  ws: WebSocket | null;
  generation: number;
  coverage: Coverage;
  capabilities: VerificationCapability[];
  cursor: number;
  events: RingBuffer;
  dropped: number;
  lossCursor: number;
  captureLost: boolean;
  generationCursor: number;
  lastActivity: number;
  pending: Pending | null;
  requests: Map<string, { actionId?: string }>;
  bodyRequests: Map<string, { actionId?: string; url: unknown; method: unknown; status?: number; pending: boolean }>;
  responseRequestIds: Set<string>;
  currentActionId?: string;
  lastCausalResult?: CapturedCausalDispatch;
  lastControlSource?: RetainedControlSource;
  lastPerformance?: RetainedPerformanceEvidence;
  performanceWindow?: PerformanceSnapshot;
  lastCommandCursor: number;
  busy: boolean;
  secrets: string[];
}

export interface VerificationBridgeOptions {
  broadcast(event: string, data: unknown): void;
  allowedSourceIps?: ReadonlySet<string>;
  allowedHosts?: ReadonlySet<string>;
  commandTimeoutMs?: number;
}

/** Owns paired sockets, command correlation and the bounded observation window. */
export class VerificationBridge {
  readonly sessions = new Map<string, VerificationSession>();
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: L.MAX_FRAME_BYTES });
  private readonly sockets = new Set<WebSocket>();
  private readonly helloTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: VerificationBridgeOptions) {}

  tick(session: VerificationSession): number {
    session.cursor = Math.max(Date.now(), session.cursor + 1);
    return session.cursor;
  }

  summary(session: VerificationSession): SessionSummary {
    return { id: session.id, origin: session.origin, runId: session.runId, connected: session.ws?.readyState === WebSocket.OPEN,
      createdAt: session.createdAt, coverage: { ...session.coverage }, cursor: session.cursor, dropped: session.dropped + session.events.bufferHealth().dropped,
      ...(session.capabilities.length ? { capabilities: [...session.capabilities] } : {}) };
  }

  create(origin: unknown, runId: unknown): SessionSummary & { token: string } {
    const appOrigin = parseAppOrigin(origin);
    if (runId !== undefined && runId !== null && (typeof runId !== "string" || !getRunById(runId))) {
      throw new VerificationHttpError(400, "runId must identify an existing run exactly");
    }
    if (this.sessions.size >= L.MAX_SESSIONS) throw new VerificationHttpError(409, "Too many application sessions; disconnect an existing session first");
    const id = randomUUID();
    const expires = setTimeout(() => this.remove(id), L.CREDENTIAL_TTL_MS);
    expires.unref();
    const session: VerificationSession = { id, origin: appOrigin, runId: runId as string | null ?? null,
      token: randomBytes(32).toString("hex"), createdAt: Date.now(), expires, ws: null, generation: 0,
      coverage: emptyCoverage(), capabilities: [], cursor: 0, events: new RingBuffer(), dropped: 0, lossCursor: 0, captureLost: false, generationCursor: 0,
      lastActivity: Date.now(), pending: null, requests: new Map(), bodyRequests: new Map(), responseRequestIds: new Set(), lastCommandCursor: 0, busy: false, secrets: [] };
    session.secrets.push(session.token);
    this.sessions.set(id, session);
    this.options.broadcast("verification_session", this.summary(session));
    return { ...this.summary(session), token: session.token };
  }

  get(id: string): VerificationSession {
    const session = this.sessions.get(id);
    if (!session) throw new VerificationHttpError(404, "Application session not found");
    return session;
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.expires);
    this.invalidate(session, "Application session ended");
    session.ws?.terminate();
    session.ws = null;
    session.token = "";
    this.sessions.delete(id);
    this.options.broadcast("verification_session", { ...this.summary(session), removed: true });
  }

  private invalidate(session: VerificationSession, error: string): void {
    session.generation++;
    session.coverage = emptyCoverage();
    session.capabilities = [];
    session.requests.clear();
    session.bodyRequests.clear();
    session.responseRequestIds.clear();
    session.currentActionId = undefined;
    session.lastCausalResult = undefined;
    session.lastControlSource = undefined;
    session.lastPerformance = undefined;
    session.performanceWindow = undefined;
    if (session.pending) {
      const pending = session.pending;
      session.pending = null;
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, cursor: pending.cursor, error, ...(pending.boundary && pending.controlSource ? { controlSource: pending.controlSource } : {}) });
    }
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = () => { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); };
    let session: VerificationSession;
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      session = this.get(url.searchParams.get("sessionId") ?? "");
      const host = hostnameOnly(req.headers.host ?? "");
      if (url.pathname !== "/verification/ws" || url.searchParams.size !== 1
        || !isAllowedRemoteAddress(req.socket.remoteAddress, this.options.allowedSourceIps ?? new Set())
        || !["localhost", "127.0.0.1", "::1"].includes(host) && !this.options.allowedHosts?.has(host)
        || req.headers.origin !== session.origin || session.ws || this.sockets.size >= L.MAX_SESSIONS * 2) return refuse();
    } catch { return refuse(); }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, session));
  }

  private connect(ws: WebSocket, session: VerificationSession): void {
    this.sockets.add(ws);
    let authenticated = false;
    let generation = -1;
    const timer = setTimeout(() => ws.terminate(), L.HELLO_TIMEOUT_MS);
    timer.unref();
    this.helloTimers.set(ws, timer);
    ws.on("error", () => ws.terminate());
    ws.on("message", (raw, isBinary) => {
      try {
        if (isBinary) throw new Error("binary frame");
        const msg = parseBrowserMessage(JSON.parse(raw.toString()));
        if (!authenticated) {
          if (msg.type !== "hello" || session.ws || !this.sessions.has(session.id)) throw new Error("unpaired socket");
          const token = Buffer.from(msg.token);
          const expected = Buffer.from(session.token);
          if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Error("invalid credential");
          clearTimeout(timer);
          this.helloTimers.delete(ws);
          this.invalidate(session, "Application reconnected");
          session.ws = ws;
          session.events = new RingBuffer();
          session.generationCursor = this.tick(session);
          session.lossCursor = session.generationCursor;
          session.captureLost = false;
          session.lastCommandCursor = session.generationCursor;
          session.coverage = { ...msg.coverage };
          session.capabilities = msg.version !== PROTOCOL_VERSION ? [...msg.capabilities] : [];
          session.lastActivity = Date.now();
          generation = session.generation;
          authenticated = true;
          ws.send(JSON.stringify({ type: "ready" }));
          this.options.broadcast("verification_session", this.summary(session));
          return;
        }
        if (session.ws !== ws || generation !== session.generation || msg.type === "hello") throw new Error("stale socket");
        if (msg.type === "event") this.acceptEvent(session, msg.event);
        else {
          const pending = session.pending;
          if (!pending || msg.id !== pending.id) throw new Error("unexpected command result");
          let performanceResult: PerformanceSnapshot | undefined;
          // Validate before resolving: a malformed causal reply must invalidate the owned turn,
          // not leave its promise detached from the generation being closed.
          if (pending.command.type === "causal-click" && msg.ok) this.captureDispatch(session, pending, !!msg.truncated);
          // A malformed typed tree must invalidate the still-owned pending promise.
          const treeResult = pending.command.type === "semantic-tree" && msg.ok ? this.sanitizeReadResult(session, pending.command, msg.result) : undefined;
          if (treeResult && msg.truncated) {
            const tree = parseSemanticTree(treeResult.value); treeIncomplete(tree, "transport-budget-limit");
            treeResult.value = sanitizeSemanticTree(tree, text => ({ value: text, truncated: false })); treeResult.incomplete = true;
          }
          if (pending.command.type === "performance" && msg.ok) {
            const snapshot = parsePerformanceSnapshot(msg.result);
            if (msg.truncated || snapshot.phase !== pending.command.phase) throw new Error("Invalid performance phase or partial response");
            const previous = session.performanceWindow;
            if (snapshot.phase === "capture" && (!previous || previous.documentId !== snapshot.documentId || previous.windowId !== snapshot.windowId
              || previous.clock.timeOriginMs !== snapshot.clock.timeOriginMs || previous.clock.sinceMs !== snapshot.clock.sinceMs
              || previous.clock.installedAtMs !== snapshot.clock.installedAtMs || (previous.clock.capturedAtMs !== null && snapshot.clock.capturedAtMs !== null && previous.clock.capturedAtMs > snapshot.clock.capturedAtMs))) throw new Error("Unmatched native performance window");
            performanceResult = scrubPerformanceMetadata(snapshot, value => this.sanitize(session, value).value);
          }
          session.pending = null;
          clearTimeout(pending.timer);
          const semanticAction = pending.command.type === "ref-click" || pending.command.type === "ref-fill";
          const isAction = semanticAction || pending.command.type === "click" || pending.command.type === "fill" || pending.command.type === "causal-click";
          if (isAction && !pending.boundary && (!semanticAction || msg.ok)) {
            pending.resolve({ ok: false, cursor: pending.cursor, error: "Application did not acknowledge the action boundary" });
            return;
          }
          const cleaned = pending.command.type === "performance" ? { value: performanceResult, incomplete: false }
            : treeResult ?? (pending.command.type === "semantic-tree" ? { value: undefined, incomplete: false } : this.sanitizeReadResult(session, pending.command, msg.result));
          const result = cleaned.value;
          const truncated = msg.truncated || cleaned.incomplete;
          if (pending.command.type === "performance") {
            session.lastPerformance = undefined;
            if (msg.ok) {
              const snapshot = result as PerformanceSnapshot;
              session.performanceWindow = snapshot;
              session.lastPerformance = { generation: session.generation, cursor: pending.cursor, snapshot };
            } else session.performanceWindow = undefined;
          }
          const value = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
          if (pending.command.type === "state") {
            const readable = msg.ok && Object.hasOwn(value, "value");
            this.append(session, { type: "state", data: { store: pending.command.store, value: readable ? value.value : "[UNSERIALIZABLE]" },
              truncated: truncated || !readable, actionId: session.currentActionId }, false);
          } else if (pending.command.type === "snapshot" && pending.command.selector) {
            const readable = msg.ok && typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0;
            this.append(session, { type: "dom", data: { selector: pending.command.selector, count: readable ? value.count : 0 },
              truncated: truncated || !readable, actionId: session.currentActionId }, false);
          }
          pending.resolve({ ok: msg.ok, cursor: pending.cursor,
            ...(pending.boundary && pending.controlSource ? { controlSource: pending.controlSource } : {}),
            // Action responses are acknowledgements; arbitrary page echoes must not persist fill input.
            result: isAction ? { acknowledged: msg.ok, ...(semanticAction ? { source: "sdk-reported" } : {}) } : result,
            ...(msg.error ? { error: String(this.sanitize(session, msg.error).value).slice(0, L.MAX_REASON_LENGTH) } : {}),
            ...(!msg.ok ? { unavailable: true } : {}),
            ...(truncated ? { truncated: true } : {}) });
        }
      } catch {
        if (authenticated && session.ws === ws) {
          session.ws = null;
          this.invalidate(session, "Application sent an invalid verification message");
          this.options.broadcast("verification_session", this.summary(session));
        }
        ws.close(1008, "Invalid verification message");
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      this.helloTimers.delete(ws);
      this.sockets.delete(ws);
      if (session.ws === ws) {
        session.ws = null;
        this.invalidate(session, "Application disconnected");
        this.options.broadcast("verification_session", this.summary(session));
      }
    });
  }

  private acceptEvent(session: VerificationSession, event: Omit<RuntimeEvent, "t">): void {
    if (event.type === "action.source") {
      const pending = session.pending;
      if (!session.capabilities.includes(SOURCE_CAPABILITY) || !pending || pending.id !== event.actionId || pending.boundary || pending.controlSource
        || !["click", "fill", "causal-click", "ref-click", "ref-fill"].includes(pending.command.type)) throw new Error("source outside its owned pre-dispatch command");
      const observation = sanitizeControlSource(event.data.observation, value => String(this.sanitize(session, value).value));
      pending.controlSource = Object.freeze({ actionId: pending.id, commandCursor: pending.cursor, cursor: this.tick(session), generation: session.generation,
        capture: "before-dispatch", observation: Object.freeze(observation) });
      return;
    }
    if (event.type === "action.reading") {
      const pending = session.pending;
      if (!session.capabilities.includes(CAUSAL_CAPABILITY) || !pending || pending.command.type !== "causal-click"
        || pending.id !== event.actionId) throw new Error("reading outside its owned causal command");
      const target = event.data.target as RelativeTarget;
      const key = relativeTargetKey(target);
      const expected = pending.command.targets.find((entry) => relativeTargetKey(entry) === key);
      const phase = event.data.phase;
      const readings = phase === "before" ? pending.before : pending.after;
      if (!expected || !readings || readings.has(key) || phase === "before" && pending.boundary
        || phase === "after" && (!pending.boundary || !pending.before?.has(key))) throw new Error("unmatched or unordered causal reading");
      const captured = this.append(session, event);
      if (!captured) throw new Error("causal reading exceeded capture capacity");
      readings.set(key, captureBaselineReading({ scope: baselineScopeForTarget(session.id, session.generation, expected),
        cursor: captured.t, fresh: true, complete: captured.data.available === true,
        ...(phase === "after" ? { actionId: pending.id } : {}), truncated: !!captured.truncated }, captured.data.value));
      return;
    }
    if (event.type === "action.boundary") {
      const pending = session.pending;
      if (!pending || pending.id !== event.actionId || !["click", "fill", "causal-click", "ref-click", "ref-fill"].includes(pending.command.type) || pending.boundary
        || pending.command.type === "causal-click" && pending.before?.size !== pending.command.targets.length) throw new Error("invalid action boundary");
      pending.boundary = true;
      session.currentActionId = pending.id;
      session.lastControlSource = pending.controlSource;
    }
    if (event.type === "network.start") {
      const requestId = event.data.requestId;
      if (typeof requestId !== "string" || !requestId || requestId.length > 128 || session.requests.has(requestId)) throw new Error("invalid request identity");
      if (session.requests.size >= L.MAX_EVENTS) { this.loss(session, "Pending network capture limit reached"); return; }
      if (event.actionId !== session.currentActionId) { this.loss(session, "Network request action attribution did not match its observed start boundary"); return; }
      if (session.capabilities.includes(BUSINESS_CAPABILITY)) {
        if (session.responseRequestIds.has(requestId)) {
          // Retain the bounded observed lifecycle for inspection; this generation has permanently lost proof authority.
          this.loss(session, "Response request identity was reused within its connection generation");
        } else {
          if (session.responseRequestIds.size >= L.MAX_EVENTS) { this.loss(session, "Response identity history limit reached"); return; }
          session.responseRequestIds.add(requestId);
        }
      }
      session.requests.set(requestId, { actionId: event.actionId });
      if (session.capabilities.includes(BUSINESS_CAPABILITY)) {
        if (session.bodyRequests.has(requestId) || session.bodyRequests.size >= L.MAX_EVENTS) { this.loss(session, "Response identity capture limit or duplicate start"); return; }
        session.bodyRequests.set(requestId, { actionId: event.actionId, url: event.data.url, method: event.data.method, pending: false });
      }
    } else if (event.type === "network") {
      const requestId = event.data.requestId;
      const request = typeof requestId === "string" ? session.requests.get(requestId) : undefined;
      if (!request) { this.loss(session, "Network completion arrived without a recorded request start"); return; }
      session.requests.delete(requestId as string);
      const body = session.bodyRequests.get(requestId as string);
      if (body) body.status = event.data.status as number;
      event = { ...event, actionId: request.actionId };
    } else if (event.type === "network.body") {
      const requestId = String(event.data.requestId);
      const body = session.bodyRequests.get(requestId);
      if (!session.capabilities.includes(BUSINESS_CAPABILITY) || !body || body.status === undefined
        || (event.data.state === "pending" ? body.pending : !body.pending)) {
        this.loss(session, "Response lifecycle lacked its negotiated owned request and headers"); return;
      }
      if (event.data.state === "pending") body.pending = true;
      else session.bodyRequests.delete(requestId);
      event = { ...event, actionId: body.actionId, data: { ...event.data, url: body.url, method: body.method, status: body.status } };
    } else if (event.type === "observer.error") {
      const observer = event.data.observer;
      if (typeof observer === "string" && Object.hasOwn(session.coverage, observer)) session.coverage[observer as keyof Coverage] = false;
    }
    // Console and application signals describe the observed interval after the acknowledged boundary.
    // They cannot opt out of a negative assertion by omitting or changing a page-supplied action id.
    if (!["network", "network.start", "network.body", "action.boundary"].includes(event.type)) event = { ...event, actionId: session.currentActionId };
    if (event.type === "capture.loss") { session.lossCursor = this.tick(session); session.captureLost = true; }
    const captured = this.append(session, event);
    if (event.type === "action.boundary" && session.pending) session.pending.actionCursor = captured?.t;
  }

  private captureDispatch(session: VerificationSession, pending: Pending, truncated: boolean): void {
    if (pending.command.type !== "causal-click" || !pending.boundary || pending.actionCursor === undefined
      || pending.before?.size !== pending.command.targets.length || pending.after?.size !== pending.command.targets.length) {
      throw new Error("causal result did not contain its complete owned turn");
    }
    const result = this.append(session, { type: "action.result", actionId: pending.id,
      data: { source: "sdk-reported", acknowledged: true }, ...(truncated ? { truncated: true } : {}) });
    if (!result) throw new Error("causal result exceeded capture capacity");
    const complete = this.observe(session, pending.cursor).complete && !truncated && !result.truncated;
    const pairs = new Map<string, CausalReadingPair>();
    for (const target of pending.command.targets) {
      const key = relativeTargetKey(target);
      const before = pending.before.get(key)!;
      const after = pending.after.get(key)!;
      if (!(before.cursor < pending.actionCursor && pending.actionCursor < after.cursor && after.cursor < result.t)) throw new Error("causal result cursor order mismatch");
      const attribution = complete && before.availability === "complete" && after.availability === "complete"
        ? captureCausalAttribution({ t: result.t, type: "action.result", actionId: pending.id,
          data: { scope: before.scope, baselineCursor: before.cursor, baselineValue: before.value,
            readingCursor: after.cursor, value: after.value } }) : undefined;
      pairs.set(key, Object.freeze({ target: Object.freeze({ ...target }), before, after, ...(attribution ? { attribution } : {}) }));
    }
    session.lastCausalResult = Object.freeze({ actionId: pending.id, actionCursor: pending.actionCursor,
      startCursor: pending.cursor, generation: session.generation, pairs });
  }

  private loss(session: VerificationSession, reason: string): void {
    session.captureLost = true;
    session.lossCursor = this.tick(session);
    session.dropped++;
    this.append(session, { type: "capture.loss", data: { reason } });
  }

  append(session: VerificationSession, raw: Omit<RuntimeEvent, "t">, activity = true): RuntimeEvent | null {
    const event: RuntimeEvent = { ...this.sanitizeEvent(session, raw), t: this.tick(session) };
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > L.MAX_EVENT_BYTES) { session.lossCursor = event.t; session.captureLost = true; session.dropped++; return null; }
    session.events.push(event, session.cursor, size);
    if (activity) session.lastActivity = Date.now();
    return event;
  }

  observe(session: VerificationSession, since: number) {
    return { session: this.summary(session), events: session.events.since(since).filter((e) => e.t > since), cursor: session.cursor,
      complete: !session.captureLost && since >= session.lossCursor && since >= session.generationCursor && !session.events.lostSince(since + 1) && !!session.ws };
  }

  command(session: VerificationSession, command: AppCommand, timeoutMs = this.options.commandTimeoutMs ?? L.COMMAND_TIMEOUT_MS): Promise<CommandResult> {
    const cursor = this.tick(session);
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, cursor, error: "Application is disconnected" });
    if (session.pending) throw new VerificationHttpError(409, "An application command is already pending");
    if (command.type === "performance" && !session.capabilities.includes(PERFORMANCE_CAPABILITY)) return Promise.resolve({ ok: false, cursor, unavailable: true, error: "Native performance evidence requires explicit SDK opt-in; no capture was made" });
    if (["find", "semantic-snapshot", "ref-click", "ref-fill"].includes(command.type) && !session.capabilities.includes(SEMANTIC_CAPABILITY)) {
      return Promise.resolve({ ok: false, cursor, unavailable: true,
        error: "Application does not support semantic references; no action was executed" });
    }
    if (command.type === "semantic-tree" && !session.capabilities.includes(TREE_CAPABILITY)) return Promise.resolve({ ok: false, cursor, unavailable: true, error: "Application does not support semantic tree snapshots; no observation was captured" });
    if (["click", "fill", "causal-click", "ref-click", "ref-fill"].includes(command.type)) { session.lastCausalResult = undefined; session.lastControlSource = undefined; }
    if (command.type === "causal-click" && !session.capabilities.includes(CAUSAL_CAPABILITY)) {
      return Promise.resolve({ ok: false, cursor, unavailable: true,
        error: "Application does not support causal readings; no action was executed" });
    }
    if ((command.type === "fill" || command.type === "ref-fill") && command.value && !session.secrets.includes(command.value)) {
      if (session.secrets.length >= 65) throw new VerificationHttpError(409, "Fill redaction capacity reached; pair a new session");
      session.secrets.push(command.value);
    }
    const id = randomUUID();
    if (["click", "fill", "causal-click", "ref-click", "ref-fill"].includes(command.type)) session.lastCommandCursor = cursor;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (session.pending?.id !== id) return;
        const pending = session.pending;
        session.pending = null;
        resolve({ ok: false, cursor, error: "Application command timed out", ...(pending.boundary && pending.controlSource ? { controlSource: pending.controlSource } : {}) });
        // A late action may still execute. Terminate its generation rather than allow an ambiguous next action.
        session.ws?.terminate();
      }, Math.min(timeoutMs, this.options.commandTimeoutMs ?? L.COMMAND_TIMEOUT_MS));
      timer.unref();
      session.pending = { id, command, cursor, resolve, timer, boundary: false,
        ...(command.type === "causal-click" ? { before: new Map(), after: new Map() } : {}) };
      try { session.ws!.send(JSON.stringify({ type: "command", id, command })); }
      catch { clearTimeout(timer); session.pending = null; resolve({ ok: false, cursor, error: "Application disconnected" }); }
    });
  }

  sanitize(session: VerificationSession, value: unknown): { value: unknown; incomplete: boolean; redacted: boolean; truncated: boolean } {
    const sanitized = sanitizeWithReport(value, { scrubString(entry) {
        let out = entry;
        for (const secret of session.secrets) {
          if (!secret || (secret.length < 4 && out !== secret)) continue;
          if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
        }
        return out;
    } });
    return { value: sanitized.value, incomplete: !!sanitized.redacted || !!sanitized.truncation,
      redacted: !!sanitized.redacted, truncated: !!sanitized.truncation };
  }

  sanitizeEvent<T extends Omit<RuntimeEvent, "t">>(session: VerificationSession, raw: T): T {
    let incomplete = raw.truncated ?? false;
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw.data)) {
      if (raw.type === "state" && key === "value" && typeof raw.data.store === "string" && isSensitiveKey(raw.data.store)) {
        data[key] = "[REDACTED]";
        incomplete = true;
        continue;
      }
      if (raw.type === "dom" && key === "selector") {
        try { parseFlowSteps([{ predicate: { kind: "element", selector: value, state: "present" } }]); }
        catch { data[key] = "[REDACTED]"; incomplete = true; continue; }
      }
      // These are validated protocol discriminators, not page text. Losing an error level can invert an absence verdict.
      if (raw.type === "console" && key === "level" || raw.type === "observer.error" && key === "observer"
        || raw.type === "action.reading" && ["phase", "available"].includes(key)
        || raw.type === "network.body" && ["source", "state", "format", "bytes", "chunks", "redacted", "status"].includes(key)
        || ["network", "network.start", "network.body"].includes(raw.type) && (["initiator", "status", "ok", "durationMs"].includes(key)
          || key === "method" && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"].includes(String(value).toUpperCase()))) {
        data[key] = value;
      } else {
        const clean = this.sanitize(session, value);
        data[key] = clean.value;
        incomplete ||= clean.incomplete;
      }
    }
    const event = { ...raw, data, ...(incomplete ? { truncated: true } : {}) };
    if (event.actionId === undefined) delete event.actionId;
    return event;
  }

  private sanitizeReadResult(session: VerificationSession, command: AppCommand, raw: unknown): { value: unknown; incomplete: boolean } {
    if (command.type === "semantic-tree") {
      const tree = sanitizeSemanticTree(raw, text => { const safe = this.sanitize(session, text); return { value: safe.value, truncated: safe.incomplete }; });
      return { value: tree, incomplete: tree.availability === "partial" };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return this.sanitize(session, raw);
    let incomplete = false;
    const value: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(raw)) {
      const clean = this.sanitize(session, entry);
      value[key] = clean.value;
      incomplete ||= clean.incomplete;
    }
    if (command.type === "state") value.store = command.store;
    if (command.type === "state" && isSensitiveKey(command.store)) { value.value = "[REDACTED]"; incomplete = true; }
    if (command.type === "snapshot" && command.selector) value.selector = command.selector;
    return { value, incomplete };
  }

  close(): void {
    for (const id of this.sessions.keys()) this.remove(id);
    for (const timer of this.helloTimers.values()) clearTimeout(timer);
    this.helloTimers.clear();
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
    this.wss.close();
  }
}
