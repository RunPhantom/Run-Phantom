import { randomBytes, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { BrowserProvider, type BrowserWorkerClient, type BrowserHostConfig } from "./browser-provider";
import { BrowserArtifactStore, type BrowserArtifact } from "./browser-artifacts";
import { BROWSER_LIMITS as B, BrowserInputError, browserArray, browserObject, browserEngine, browserGeneration, browserId, browserText,
  parseBrowserAction, parseBrowserOpen, parseExecutionContext, scrubBrowserSecrets, ARTIFACT_ID,
  type BrowserSummary, type BrowserActionResult, type BrowserObservation, type ExecutionContext } from "./browser-contract";
import { VERIFICATION_LIMITS as L, type Coverage, type Predicate, type RuntimeEvent, type VerificationReport, type Verdict } from "./protocol";
import { parsePredicate, validateOrigin } from "./validation";
import { RingBuffer } from "./ring-buffer";
import { evaluatePredicate } from "./predicates";
import { sanitizeWithReport } from "./serialization";
import { saveReport } from "./store";
import { boundReportContext } from "./report-context";
import { getRunById } from "../db";
import type { BrowserCompatibility } from "./browser-types";
import { ACCESSIBILITY_LIMITS, parseAccessibilityRequest, normalizeAccessibility, parseAccessibilityEvidence, type AccessibilityEvidence } from "./accessibility";

interface Turn { ticket: number; generation: number; since: number; started: number; actionId?: string; predicate?: Predicate; name: string; report?: VerificationReport }
interface BrowserSession {
  summary: BrowserSummary; worker: BrowserWorkerClient; events: RingBuffer; cursor: number; busy: boolean; ticket: number;
  lastActivity: number; secrets: string[]; turn?: Turn; requests: Map<string, { actionId?: string; generation: number }>; revision?: string;
  closing?: Promise<{ session: BrowserSummary; artifacts: BrowserArtifact[] }>; closeConfirmed?: boolean; artifactIds: string[];
}
const emptyCoverage = (): Coverage => ({ network: false, console: false, dom: false, state: false, signal: false, route: false });
const opaque = () => randomBytes(16).toString("hex");
function coverage(value: unknown): Coverage {
  const b = browserObject(value, ["network", "console", "dom", "state", "signal", "route"]);
  if (Object.values(b).length !== 6 || Object.values(b).some(value => typeof value !== "boolean") || b.state || b.signal) throw new BrowserInputError(503, "Browser observer state is invalid");
  return b as unknown as Coverage;
}
function result(value: unknown, actionId: string, generation: number): BrowserActionResult {
  const b = browserObject(value, ["actionId", "generationBefore", "generationAfter", "dispatch", "inputMode", "reason"]);
  if (b.actionId !== actionId || b.generationBefore !== generation || !["not-dispatched", "completed", "unknown"].includes(b.dispatch as string) || !["trusted-browser", "none", "unknown"].includes(b.inputMode as string)) throw new BrowserInputError(503, "Browser input result is invalid");
  return { actionId, generationBefore: generation, generationAfter: browserGeneration(b.generationAfter), dispatch: b.dispatch as BrowserActionResult["dispatch"], inputMode: b.inputMode as BrowserActionResult["inputMode"],
    ...(b.reason === undefined ? {} : { reason: browserText(b.reason, 256) }) };
}
function selectors(predicate: Predicate): string[] {
  if (predicate.kind === "element") return [predicate.selector];
  if (predicate.kind === "allOf" || predicate.kind === "anyOf") return [...new Set(predicate.predicates.flatMap(selectors))];
  return [];
}

/** Browser orchestration shares the evaluator/store, never paired SDK authority or handles. */
export class BrowserAutomation {
  readonly provider: BrowserProvider;
  #sessions = new Map<string, BrowserSession>();
  #artifacts?: BrowserArtifactStore;
  #recording?: string;
  #shutdown = false;
  #resetting = false;
  #lifecycle = 0;
  constructor(config: BrowserHostConfig, private readonly broadcast: (event: string, data: unknown) => void = () => {}) { this.provider = new BrowserProvider(config); }
  get artifacts(): BrowserArtifactStore { return this.#artifacts ??= new BrowserArtifactStore(this.provider.config.artifactRoot ?? path.join(os.homedir(), ".runphantom", "browser-artifacts")); }
  setControlOrigins(origins: string[]): void { this.provider.config.controlOrigins = origins; }
  summaries(): BrowserSummary[] { return [...this.#sessions.values()].map(session => this.#summary(session)); }
  #summary(session: BrowserSession): BrowserSummary { return { ...session.summary, coverage: { ...session.summary.coverage }, compatibility: { ...session.summary.compatibility }, ...(session.busy && session.summary.state === "ready" ? { state: "busy" } : {}) }; }
  #get(id: unknown): BrowserSession { const session = this.#sessions.get(browserId(id)); if (!session) throw new BrowserInputError(404, "Browser connection not found"); return session; }
  #current(session: BrowserSession, generation: unknown): number {
    const wanted = browserGeneration(generation);
    if (wanted !== session.summary.generation) throw new BrowserInputError(409, "Browser generation changed; refresh the current connection");
    return wanted;
  }
  #tick(session: BrowserSession): number { return session.cursor = Math.max(Date.now(), session.cursor + 1); }
  #scrub(session: BrowserSession, value: unknown) { const safe = sanitizeWithReport(value, { scrubString: text => scrubBrowserSecrets(text, session.secrets) }); return { value: safe.value, redacted: !!safe.redacted, truncated: !!safe.truncation }; }
  #state(session: BrowserSession, generation: number, value: unknown): void {
    if (session.summary.state === "closed" || session.summary.state === "unavailable") return;
    try {
      const b = browserObject(value, ["origin", "engine", "engineVersion", "state", "coverage", "pending", "loss", "video", "lastActivity", "networkProfile", "compatibility"]);
      if (generation < session.summary.generation || !["ready", "closed"].includes(b.state as string) || typeof b.loss !== "boolean" || !["off", "recording", "stopped"].includes(b.video as string)
        || !Number.isSafeInteger(b.pending) || (b.pending as number) < 0 || (b.pending as number) > B.REQUESTS || !Number.isSafeInteger(b.lastActivity) || (b.lastActivity as number) > Date.now() + 1000) throw new Error();
      const safeOrigin = b.origin === null ? null : validateOrigin(b.origin);
      const engineVersion = browserText(b.engineVersion, 64, true);
      if (!/^[0-9A-Za-z.+ ()-]*$/.test(engineVersion)) throw new Error();
      const profile = browserObject(b.compatibility, ["qualification", "sameOrigin", "foreign", "webSocket", "redirects"]);
      if (b.networkProfile !== "bounded-http-v1" || profile.qualification !== "initial-only" || profile.redirects !== "unavailable"
        || !["cookie-free", "cookie-free-or-controlled-cookies"].includes(profile.sameOrigin as string)
        || !["conditional-cookie-free-get-head", "unavailable"].includes(profile.foreign as string) || !["denied", "unqualified"].includes(profile.webSocket as string)
        || profile.foreign !== "unavailable" && (session.summary.ownership !== "owned" || b.engine !== "chromium" || engineVersion !== "151.0.7922.34")
        || profile.webSocket !== (session.summary.ownership === "owned" ? "denied" : "unqualified")
        || profile.sameOrigin !== (session.summary.ownership === "owned" && b.engine !== "webkit" ? "cookie-free-or-controlled-cookies" : "cookie-free")) throw new Error();
      if (generation !== session.summary.generation) session.artifactIds = [];
      Object.assign(session.summary, { generation, origin: safeOrigin, engine: browserEngine(b.engine), engineVersion, state: b.state,
        coverage: coverage(b.coverage), pending: b.pending, loss: session.summary.loss || b.loss, video: b.video,
        networkProfile: "bounded-http-v1", compatibility: profile as unknown as BrowserCompatibility });
      session.lastActivity = Math.max(session.lastActivity, b.lastActivity as number);
      if (session.summary.video !== "recording" && this.#recording === session.summary.id) this.#recording = undefined;
    } catch { session.summary.loss = true; session.summary.coverage = emptyCoverage(); }
  }
  #event(session: BrowserSession, generation: number, value: unknown): void {
    if (["closed", "unavailable"].includes(session.summary.state)) return;
    try {
      const b = browserObject(value, ["type", "data", "actionId", "truncated"]);
      if (typeof b.type !== "string" || !["network.start", "network", "console", "dom", "route", "action.boundary", "action.result", "capture.loss", "observer.error"].includes(b.type)
        || b.truncated !== undefined && b.truncated !== true || generation < session.summary.generation) throw new Error();
      const allowed = b.type.startsWith("network") ? ["requestId", "url", "method", "status", "failed", "resourceType"] : b.type === "console" ? ["level", "message"] : b.type === "dom" ? ["selector", "count"] : b.type === "route" ? ["url"] : b.type === "observer.error" ? ["observer", "reason"] : b.type === "capture.loss" ? ["reason"] : ["source", "dispatch"];
      const data = browserObject(b.data, allowed);
      const actionId = b.actionId === undefined ? undefined : browserId(b.actionId);
      if (b.type === "network.start") {
        const requestId = browserId(data.requestId);
        if (session.requests.size >= B.REQUESTS || session.requests.has(requestId)) throw new Error();
        session.requests.set(requestId, { actionId, generation });
      }
      if (b.type === "network") {
        const id = browserId(data.requestId), start = session.requests.get(id);
        if (!start || start.actionId !== actionId) throw new Error();
        session.requests.delete(id);
        if (data.status !== undefined && (!Number.isInteger(data.status) || (data.status as number) < 100 || (data.status as number) > 599)) throw new Error();
      }
      if (b.type === "console" && (typeof data.level !== "string" || typeof data.message !== "string" || data.message.length > 4096)) throw new Error();
      if (b.type === "dom" && (!Number.isSafeInteger(data.count) || (data.count as number) < 0 || typeof data.selector !== "string" || data.selector.length > 1024)) throw new Error();
      const sanitized = this.#scrub(session, data); const safeData = sanitized.value as Record<string, unknown>;
      for (const key of b.type === "console" ? ["level"] : b.type.startsWith("network") ? ["requestId", "method", "status", "failed", "resourceType"] : b.type === "dom" ? ["count"] : []) if (Object.hasOwn(data, key)) safeData[key] = data[key];
      const event: RuntimeEvent = { t: this.#tick(session), type: b.type, data: safeData, ...(actionId ? { actionId } : {}), ...(b.truncated || sanitized.redacted || sanitized.truncated ? { truncated: true } : {}) };
      const bytes = Buffer.byteLength(JSON.stringify(event)); if (bytes > L.MAX_EVENT_BYTES) throw new Error();
      session.events.push(event, session.cursor, bytes);
      if (b.type !== "dom") session.lastActivity = Date.now();
      if (b.type === "capture.loss") session.summary.loss = true;
      if (b.type === "observer.error") session.summary.coverage.dom = false;
    } catch { session.summary.loss = true; }
  }
  #available(): void { if (this.#shutdown || this.#resetting) throw new BrowserInputError(503, "Browser service is closing or resetting"); }
  async #allocate(ownership: "owned" | "attached", engine: BrowserSummary["engine"], runId?: string): Promise<BrowserSession> {
    this.#available(); const lifecycle = this.#lifecycle;
    if ([...this.#sessions.values()].filter(s => !["closed", "unavailable"].includes(s.summary.state)).length >= B.SESSIONS) throw new BrowserInputError(409, "Two browser connections are already allocated");
    if (runId && !getRunById(runId)) throw new BrowserInputError(400, "Existing linked run required");
    const worker = await this.provider.start(ownership);
    if (lifecycle !== this.#lifecycle || this.#shutdown || this.#resetting) { await worker.close(); throw new BrowserInputError(503, "Browser service changed during allocation"); }
    const session: BrowserSession = { summary: { id: worker.id, origin: null, runId: runId ?? null, ownership, engine, providerVersion: this.provider.status().providerVersion!, engineVersion: "", generation: 0, state: ownership === "attached" ? "selecting" : "opening", coverage: emptyCoverage(), history: ownership === "owned" ? "from-open" : "from-selection", loss: false, pending: 0, video: "off", networkProfile: "bounded-http-v1", compatibility: { qualification: "initial-only", sameOrigin: ownership === "owned" && engine !== "webkit" ? "cookie-free-or-controlled-cookies" : "cookie-free", foreign: "unavailable", webSocket: ownership === "owned" ? "denied" : "unqualified", redirects: "unavailable" } },
      worker, events: new RingBuffer(), cursor: Date.now(), busy: false, ticket: 0, lastActivity: Date.now(), secrets: [], requests: new Map(), artifactIds: [] };
    if (this.#sessions.size >= 100) { const old = [...this.#sessions].find(([, s]) => ["closed", "unavailable"].includes(s.summary.state)); if (old) this.#sessions.delete(old[0]); }
    this.#sessions.set(worker.id, session);
    worker.onState = (generation, value) => this.#state(session, generation, value);
    worker.onEvent = (generation, value) => this.#event(session, generation, value);
    worker.onLost = () => { if (session.summary.state !== "closed") { session.summary.state = "unavailable"; session.summary.loss = true; session.summary.generation++; session.summary.coverage = emptyCoverage(); } };
    return session;
  }
  async open(value: unknown): Promise<BrowserSummary> {
    const open = parseBrowserOpen(value);
    if (this.provider.config.controlOrigins?.includes(new URL(open.url).origin)) throw new BrowserInputError(400, "The daemon control origin cannot be a browser target");
    if (open.recordVideo && this.#recording) throw new BrowserInputError(409, "One private video recorder is already active");
    if (open.recordVideo) this.#recording = "opening";
    let session: BrowserSession;
    try { session = await this.#allocate("owned", open.engine, open.runId); }
    catch (error) { if (open.recordVideo) this.#recording = undefined; throw error; }
    session.busy = true;
    if (open.recordVideo) this.#recording = session.summary.id;
    try {
      const reply = await session.worker.request("open", 0, open, B.START_MS + 2000);
      if (!reply.ok) throw new BrowserInputError(503, reply.reason ?? "Browser engine unavailable");
      this.#state(session, reply.generation, reply.result);
      if (session.summary.loss || session.summary.state !== "ready") throw new BrowserInputError(503, "Browser observation unavailable");
      session.busy = false; return this.#summary(session);
    } catch (error) { await this.closeSession(session.summary.id, session.summary.generation); this.#sessions.delete(session.summary.id); throw error; }
  }
  async attachedPages(): Promise<{ session: BrowserSummary; revision: string; pages: Array<{ pageId: string; origin: string }>; capped: boolean }> {
    const session = await this.#allocate("attached", "chromium");
    session.busy = true;
    try {
      const reply = await session.worker.request("list", 0, {}, B.START_MS + 2000);
      if (!reply.ok) throw new BrowserInputError(503, reply.reason ?? "Attached browser unavailable");
      const b = browserObject(reply.result, ["revision", "pages", "capped", "engineVersion"]); session.revision = browserId(b.revision);
      const pages = browserArray(b.pages, B.PAGES).map(value => { const item = browserObject(value, ["pageId", "origin"]); return { pageId: browserId(item.pageId), origin: validateOrigin(item.origin) }; });
      if (typeof b.capped !== "boolean") throw new Error("Invalid page list");
      session.summary.engineVersion = browserText(b.engineVersion, 64); session.busy = false; return { session: this.#summary(session), revision: session.revision, pages, capped: b.capped };
    } catch (error) { await this.closeSession(session.summary.id, session.summary.generation); this.#sessions.delete(session.summary.id); throw error; }
  }
  async selectPage(id: unknown, value: unknown): Promise<BrowserSummary> {
    this.#available();
    const session = this.#get(id), b = browserObject(value, ["generation", "revision", "pageId"]); this.#current(session, b.generation);
    if (session.busy || session.summary.state !== "selecting" || b.revision !== session.revision) throw new BrowserInputError(409, "Attached listing changed; refresh explicit page selection");
    session.busy = true;
    try { const reply = await session.worker.request("select", session.summary.generation, { revision: browserId(b.revision), pageId: browserId(b.pageId) });
      if (!reply.ok) throw new BrowserInputError(409, reply.reason ?? "Selected page unavailable"); this.#state(session, reply.generation, reply.result); return this.#summary(session);
    } finally { session.busy = false; }
  }
  observe(id: unknown, since?: unknown): BrowserObservation {
    const session = this.#get(id), cursor = since === undefined ? 0 : browserGeneration(since);
    if (cursor > session.cursor) throw new BrowserInputError(400, "Observation cursor is ahead of the connection");
    return { session: this.#summary(session), cursor: session.cursor, events: session.events.since(cursor + 1), complete: !session.summary.loss && !session.events.lostSince(cursor + 1) && session.summary.state === "ready", dropped: session.events.bufferHealth().dropped };
  }
  #begin(session: BrowserSession, value: unknown, check: boolean): { body: Record<string, unknown>; turn: Turn } {
    this.#available();
    const body = browserObject(value, check ? ["generation", "action", "predicate", "name"] : ["generation", "action"]);
    const generation = this.#current(session, body.generation);
    if (session.busy || session.summary.state !== "ready") throw new BrowserInputError(409, "Browser connection is busy or unavailable");
    const turn: Turn = { ticket: ++session.ticket, generation, since: this.#tick(session), started: Date.now(), name: body.name === undefined ? "Browser outcome" : browserText(body.name, 128),
      ...(check ? { predicate: parsePredicate(body.predicate) } : {}), ...(body.action === undefined ? {} : { actionId: opaque() }) };
    if (!check && body.action === undefined) throw new BrowserInputError(400, "Browser action required");
    if (body.action !== undefined) body.action = parseBrowserAction(body.action);
    session.busy = true; session.turn = turn; return { body, turn };
  }
  async #dispatch(session: BrowserSession, turn: Turn, raw: unknown): Promise<BrowserActionResult> {
    const command = parseBrowserAction(raw);
    if (command.type === "fill" && command.value && !session.secrets.includes(command.value)) {
      if (session.secrets.length >= B.SECRET_COUNT || session.secrets.reduce((n, s) => n + Buffer.byteLength(s), 0) + Buffer.byteLength(command.value) > B.SECRET_BYTES) throw new BrowserInputError(409, "Input redaction capacity reached; open a new connection");
      session.secrets.push(command.value);
    }
    try {
      const reply = await session.worker.request("action", turn.generation, { action: command, actionId: turn.actionId });
      if (!reply.ok) return { actionId: turn.actionId!, generationBefore: turn.generation, generationAfter: session.summary.generation, dispatch: "not-dispatched", inputMode: "none", reason: reply.reason };
      const received = result(reply.result, turn.actionId!, turn.generation);
      if (session.ticket !== turn.ticket || received.generationAfter !== turn.generation) return this.#unknown(session, turn);
      return received;
    } catch { session.summary.loss = true; await this.closeSession(session.summary.id, session.summary.generation); return this.#unknown(session, turn); }
  }
  #unknown(session: BrowserSession, turn: Turn): BrowserActionResult { return { actionId: turn.actionId!, generationBefore: turn.generation, generationAfter: session.summary.generation, dispatch: "unknown", inputMode: "unknown", reason: "Input may have started; current browser authority changed. No retry occurred." }; }
  async act(id: unknown, value: unknown): Promise<{ action: BrowserActionResult; observation: BrowserObservation }> {
    const session = this.#get(id), { body, turn } = this.#begin(session, value, false);
    try { return { action: await this.#dispatch(session, turn, body.action), observation: this.observe(id, turn.since) }; }
    finally { if (session.ticket === turn.ticket) { session.busy = false; session.turn = undefined; } }
  }
  #report(session: BrowserSession, turn: Turn, verdict: Verdict, settled: boolean, execution: ExecutionContext): VerificationReport {
    if (turn.report) return turn.report;
    const observed = this.observe(session.summary.id, turn.since);
    const context = boundReportContext({ origin: session.summary.origin!, quietMs: L.QUIET_MS, redacted: false, truncated: false, execution,
      checks: [{ step: 1, predicate: turn.predicate!, status: verdict.status, reason: verdict.reason, since: turn.since, through: observed.cursor,
        generation: turn.generation, coverage: { ...session.summary.coverage }, complete: observed.complete && session.summary.generation === turn.generation,
        dropped: observed.dropped, settled }] }, value => this.#scrub(session, value));
    turn.report = saveReport({ ...verdict, id: randomUUID(), sessionId: session.summary.id, runId: session.summary.runId, flowId: null,
      name: String(this.#scrub(session, turn.name).value), reason: String(this.#scrub(session, verdict.reason).value), createdAt: Date.now(), context,
      evidence: verdict.evidence.map(event => this.#scrub(session, event).value as RuntimeEvent) });
    this.broadcast("verification_report", turn.report); return turn.report;
  }
  #execution(session: BrowserSession, turn: Turn, action?: BrowserActionResult): ExecutionContext {
    return parseExecutionContext({ formatVersion: 1, backend: "trusted-browser", engine: session.summary.engine, providerVersion: session.summary.providerVersion, ownership: session.summary.ownership,
      generation: turn.generation, inputMode: action?.inputMode ?? "none", dispatch: action?.dispatch ?? "not-dispatched", ...(turn.actionId ? { actionId: turn.actionId } : {}),
      ...(session.artifactIds.length ? { artifactIds: session.artifactIds.slice(-3) } : {}) });
  }
  async check(id: unknown, value: unknown): Promise<{ action?: BrowserActionResult; report: VerificationReport }> {
    const session = this.#get(id), { body, turn } = this.#begin(session, value, true);
    let action: BrowserActionResult | undefined;
    let verdict: Verdict = { status: "inconclusive", reason: "Browser evidence is unavailable", evidence: [] }, settled = false;
    try {
      if (body.action !== undefined) action = await this.#dispatch(session, turn, body.action);
      const deadline = Date.now() + L.CHECK_TIMEOUT_MS;
      do {
        if (session.ticket !== turn.ticket || session.summary.generation !== turn.generation || session.summary.state !== "ready" || action && action.dispatch !== "completed") break;
        const read = await session.worker.request("read", turn.generation, { selectors: selectors(turn.predicate!) });
        if (!read.ok) break;
        const observed = this.observe(id, turn.since);
        settled = session.summary.coverage.network && session.summary.pending === 0 && session.requests.size === 0 && Date.now() - Math.max(turn.started, session.lastActivity) >= L.QUIET_MS;
        verdict = evaluatePredicate(turn.predicate!, { events: observed.events, coverage: session.summary.coverage, complete: observed.complete, settled, actionId: turn.actionId });
        if (settled) break;
        await new Promise(resolve => setTimeout(resolve, L.POLL_MS));
      } while (Date.now() < deadline);
      if (session.ticket !== turn.ticket || session.summary.generation !== turn.generation || session.summary.state !== "ready" || !settled || action && action.dispatch !== "completed") verdict = { status: "inconclusive", reason: "Current browser authority, input completion or bounded quiet coverage is unavailable; no business success was inferred.", evidence: verdict.evidence };
      return { ...(action ? { action } : {}), report: this.#report(session, turn, verdict, settled, this.#execution(session, turn, action)) };
    } catch { return { ...(action ? { action } : {}), report: this.#report(session, turn, { status: "inconclusive", reason: "Browser worker became unavailable while collecting the declared outcome", evidence: [] }, false, this.#execution(session, turn, action)) }; }
    finally { if (session.ticket === turn.ticket) { session.busy = false; session.turn = undefined; } }
  }
  #admit(session: BrowserSession, value: unknown, generation: number, rawConsent: boolean): BrowserArtifact {
    const b = browserObject(value, ["file", "kind", "raw", "maskScope"]);
    if (b.kind !== "screenshot" && b.kind !== "video" || typeof b.raw !== "boolean") throw new BrowserInputError(503, "Capture metadata unavailable");
    const file = browserText(b.file, 42), extension = b.kind === "video" ? ".webm" : ".png";
    if (!file.endsWith(extension) || !ARTIFACT_ID.test(file.slice(0, -extension.length))) throw new BrowserInputError(503, "Capture identity unavailable");
    const max = b.kind === "video" ? B.VIDEO_BYTES : B.PNG_BYTES; let fd: number | undefined;
    try {
      fd = openSync(path.join(session.worker.spool, file), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error();
      const bytes = Buffer.alloc(stat.size + 1); let read = 0, chunk = 0;
      while ((chunk = readSync(fd, bytes, read, bytes.length - read, null)) > 0) { read += chunk; if (read > stat.size) throw new Error(); }
      return this.artifacts.admit(bytes.subarray(0, read), { kind: b.kind, raw: b.raw, maskScope: b.kind === "video" ? "none" : b.maskScope as BrowserArtifact["maskScope"],
        engine: session.summary.engine, ownership: session.summary.ownership, generation, ...(rawConsent ? { rawConsent: true } : {}) });
    } catch (error) { if (error instanceof BrowserInputError) throw error; throw new BrowserInputError(503, "Captured artifact unavailable"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  async audit(id: unknown, value: unknown): Promise<AccessibilityEvidence> {
    this.#available();
    const session = this.#get(id), request = parseAccessibilityRequest(value, session.secrets), generation = this.#current(session, request.generation);
    if (session.busy || session.summary.state !== "ready") throw new BrowserInputError(409, "Browser connection is busy or unavailable");
    const identity = { sessionId: session.summary.id, generation, capturedAt: Date.now() };
    if (session.summary.ownership !== "owned" || session.summary.engine !== "chromium") {
      const unavailable = normalizeAccessibility(request, identity, undefined, session.secrets); unavailable.loss.push("unsupported-browser"); return unavailable;
    }
    session.busy = true; const ticket = ++session.ticket;
    try {
      const reply = await session.worker.request("audit", generation, { request, identity }, ACCESSIBILITY_LIMITS.engineMs + B.CLOSE_MS + 1000);
      if (!reply.ok || reply.generation !== generation || session.ticket !== ticket || session.summary.generation !== generation || session.summary.state !== "ready")
        throw new BrowserInputError(409, "Browser audit authority changed; no current result was accepted");
      return parseAccessibilityEvidence(reply.result, request, identity, session.secrets);
    } catch (error) {
      if (session.closing) await session.closing;
      else await this.closeSession(session.summary.id, session.summary.generation);
      if (error instanceof BrowserInputError) throw error;
      throw new BrowserInputError(503, "Native accessibility evidence is unavailable; the owned connection was closed");
    } finally { if (session.ticket === ticket) session.busy = false; }
  }
  async capture(id: unknown, value: unknown): Promise<BrowserArtifact> {
    this.#available();
    const session = this.#get(id), b = browserObject(value, ["generation", "raw", "rawConsent"]); const generation = this.#current(session, b.generation);
    if (session.busy || session.summary.state !== "ready") throw new BrowserInputError(409, "Browser connection is busy or unavailable");
    if (b.raw !== undefined && typeof b.raw !== "boolean" || b.raw && b.rawConsent !== true || b.rawConsent !== undefined && b.rawConsent !== true) throw new BrowserInputError(400, "Private raw capture requires explicit consent");
    session.busy = true; const ticket = ++session.ticket;
    try {
      const reply = await session.worker.request("capture", generation, { raw: b.raw === true, ...(b.rawConsent ? { rawConsent: true } : {}) });
      if (!reply.ok || ticket !== session.ticket || generation !== session.summary.generation) throw new BrowserInputError(409, reply.reason ?? "Capture authority changed");
      const artifact = this.#admit(session, reply.result, generation, b.rawConsent === true); session.artifactIds = [...session.artifactIds.slice(-2), artifact.id]; return artifact;
    } finally { if (ticket === session.ticket) session.busy = false; }
  }
  async closeSession(id: unknown, generation: unknown): Promise<{ session: BrowserSummary; artifacts: BrowserArtifact[] }> {
    const session = this.#get(id); if (session.closing) return session.closing; this.#current(session, generation);
    session.closing = this.#closeSession(session); return session.closing;
  }
  async #closeSession(session: BrowserSession): Promise<{ session: BrowserSummary; artifacts: BrowserArtifact[] }> {
    const before = session.summary.generation;
    const turn = session.turn; session.ticket++; session.busy = false; session.summary.generation++; session.summary.state = "closed"; session.summary.coverage = emptyCoverage();
    if (turn?.predicate && !turn.report) this.#report(session, turn, { status: "inconclusive", reason: "Browser operation cancelled; input dispatch may be unknown. No retry occurred.", evidence: [] }, false, this.#execution(session, turn, turn.actionId ? this.#unknown(session, turn) : undefined));
    const artifacts: BrowserArtifact[] = [];
    try {
      const reply = await session.worker.request("close", before, {}, B.CLOSE_MS / 2);
      if (reply.ok) { const b = browserObject(reply.result, ["closed", "artifacts"]); session.closeConfirmed = b.closed === true; for (const value of browserArray(b.artifacts, 1)) { try { artifacts.push(this.#admit(session, value, before, true)); } catch { session.summary.reason = "Flushed private video was unavailable or exceeded its admitted limit"; } } }
    } catch { session.summary.reason = "Browser close required bounded worker teardown"; }
    finally { await session.worker.close(); if (this.#recording === session.summary.id) this.#recording = undefined; session.summary.video = session.summary.video === "off" ? "off" : "stopped"; }
    return { session: this.#summary(session), artifacts };
  }
  async reset(): Promise<void> {
    this.#available(); this.#resetting = true; this.#lifecycle++;
    const sessions = [...this.#sessions.values()].filter(session => !session.worker.proof.reaped);
    try {
      // Each call fences its ticket/generation synchronously before any teardown await.
      await Promise.all(sessions.map(session => this.closeSession(session.summary.id, session.summary.generation)));
      await this.provider.close();
      if (sessions.some(session => !session.closeConfirmed || !session.worker.proof.reaped)) throw new BrowserInputError(503, "Browser teardown could not be confirmed; data was not cleared");
    } finally { this.#resetting = false; }
  }
  async close(): Promise<void> {
    this.#shutdown = true; this.#lifecycle++;
    const sessions = [...this.#sessions.values()].filter(session => !session.worker.proof.reaped);
    // Fence every live turn before the first owned teardown can yield.
    await Promise.all(sessions.map(session => this.closeSession(session.summary.id, session.summary.generation)));
    await this.provider.close();
  }
}
