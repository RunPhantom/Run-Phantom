import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export interface PortableChild extends EventEmitter {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface PortableClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  sleep(ms: number): Promise<void>;
}

export const portableClock: PortableClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

type Failure = "NONE" | "RESERVATION_FAILED" | "SETUP_FAILED" | "SPAWN_FAILED" | "EXITED_BEFORE_READY" | "HEALTH_NOT_READY" | "PRODUCT_FAILURE" | "CLEANUP_FAILED" | "CLEANUP_UNCONFIRMED" | "PROFILE_REMOVE_FAILED" | "DIAGNOSTIC_OVERFLOW";
type Phase = "RESERVE" | "SETUP" | "SPAWN" | "HEALTH" | "READY" | "PRODUCT" | "TERM" | "KILL" | "CONFIRM" | "REAPED" | "RETAINED" | "FAILED";
type Event = "RESERVATION_OPENED" | "RESERVATION_RELEASED" | "SPAWN_REQUESTED" | "SPAWNED" | "SPAWN_FAILED" | "CHILD_ERROR" | "EXIT_OBSERVED" | "CLOSE_OBSERVED" | "HEALTH_OK" | "HEALTH_NON_OK" | "HEALTH_TRANSPORT" | "TERM_SENT" | "TERM_FAILED" | "KILL_SENT" | "KILL_FAILED" | "REAP_CONFIRMED" | "REAP_UNCONFIRMED" | "PROFILE_REMOVED" | "PROFILE_RETAINED" | "SETUP_FAILED";
const errorCodes = ["NONE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EADDRINUSE", "EACCES", "EPERM", "ENOENT", "EPIPE", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "OTHER"] as const;
type SafeCode = typeof errorCodes[number];
const signals = ["NONE", "SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT", "SIGHUP", "SIGABRT", "SIGSEGV", "SIGBREAK", "OTHER"] as const;
type Signal = typeof signals[number];
const safeNumber = (value: number) => Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
const count = (value: number) => Math.floor(safeNumber(value));
function dataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try { const property = Object.getOwnPropertyDescriptor(value, key); return property && "value" in property ? property.value : undefined; }
  catch { return undefined; }
}
function errorCode(error: unknown): SafeCode {
  const direct = dataProperty(error, "code");
  const code = direct === undefined ? dataProperty(dataProperty(error, "cause"), "code") : direct;
  return errorCodes.find(allowed => allowed === code) ?? "OTHER";
}
function signalCode(signal: unknown): Signal { return signals.find(allowed => allowed === signal) ?? "OTHER"; }

class StreamDigest {
  private hash = createHash("sha256");
  private bytes = 0;
  private ended = false;
  private stop = () => {};
  constructor(stream: Readable | null) {
    if (!stream) { this.ended = true; return; }
    const data = (chunk: Buffer | string) => {
      this.bytes = count(this.bytes + Buffer.byteLength(chunk));
      this.hash.update(chunk);
    };
    const ended = () => { this.ended = true; };
    const error = () => {};
    this.stop = () => {
      this.ended = true;
      stream.off("data", data); stream.off("end", ended); stream.off("close", ended); stream.off("error", error);
    };
    stream.on("data", data); stream.once("end", ended); stream.once("close", ended); stream.on("error", error);
  }
  close() { this.stop(); }
  snapshot() { return { bytes: this.bytes, sha256: this.hash.copy().digest("hex"), phase: this.ended ? "ENDED" as const : "ACTIVE" as const }; }
}

class Diagnostics {
  primaryFailure: Failure = "NONE";
  secondaryCleanupFailure: Failure = "NONE";
  phase: Phase = "SETUP";
  spawn: "PENDING" | "SPAWNED" | "FAILED" = "PENDING";
  terminal: "NONE" | "EXIT_CODE" | "SIGNAL_CODE" | "EXIT_EVENT" | "CLOSE_EVENT" | "NO_CHILD_CREATED" = "NONE";
  cleanup: "NONE" | "REAPED" | "RETAINED_UNCONFIRMED" | "FAILED" = "NONE";
  signal: Signal = "NONE";
  exitClass: "NONE" | "ZERO" | "NONZERO" | "OTHER" = "NONE";
  health: "NONE" | "OK_HTTP" | "NON_OK_HTTP" | "TRANSPORT_ERROR" = "NONE";
  status: number | null = null;
  healthCode: SafeCode = "NONE";
  attempts = 0;
  termAttempts = 0;
  killAttempts = 0;
  private started: number;
  private stdout = new StreamDigest(null);
  private stderr = new StreamDigest(null);
  private events: { event: Event; phase: Phase; elapsedMs: number; code: SafeCode }[] = [];
  private droppedEvents = 0;
  constructor(private clock: PortableClock) { this.started = safeNumber(clock.now()); }
  attach(child: PortableChild) { this.stdout = new StreamDigest(child.stdout); this.stderr = new StreamDigest(child.stderr); }
  detachStreams() { this.stdout.close(); this.stderr.close(); }
  fail(code: Failure) { if (this.primaryFailure === "NONE") this.primaryFailure = code; }
  cleanupFailure(code: Failure) { this.secondaryCleanupFailure = code; }
  elapsed() { return safeNumber(this.clock.now() - this.started); }
  event(event: Event, phase: Phase, code: SafeCode = "NONE") {
    this.phase = phase;
    if (this.events.length === 32) { this.events.shift(); this.droppedEvents = count(this.droppedEvents + 1); }
    this.events.push({ event, phase, elapsedMs: this.elapsed(), code });
  }
  snapshot() {
    return {
      schemaVersion: 2 as const,
      primaryFailure: this.primaryFailure, secondaryCleanupFailure: this.secondaryCleanupFailure, phase: this.phase,
      lifecycle: { spawn: this.spawn, terminal: this.terminal, cleanup: this.cleanup, signal: this.signal, exitClass: this.exitClass },
      health: { observation: this.health, status: this.status, code: this.healthCode },
      metrics: { attempts: Math.min(200, count(this.attempts)), termAttempts: Math.min(1, count(this.termAttempts)), killAttempts: Math.min(1, count(this.killAttempts)), elapsedMs: this.elapsed() },
      streams: { stdout: this.stdout.snapshot(), stderr: this.stderr.snapshot() },
      events: this.events.map(event => ({ event: event.event, phase: event.phase, elapsedMs: event.elapsedMs, code: event.code })),
      truncation: this.droppedEvents ? "EVENTS_DROPPED" : "NONE", droppedEvents: this.droppedEvents,
    };
  }
  serialize() {
    const projection = this.snapshot();
    while (Buffer.byteLength(JSON.stringify(projection), "utf8") > 16384 && projection.events.length) {
      projection.events.shift(); projection.droppedEvents = count(projection.droppedEvents + 1); projection.truncation = "EVENTS_DROPPED";
    }
    if (Buffer.byteLength(JSON.stringify(projection), "utf8") > 16384) {
      return JSON.stringify({ schemaVersion: 2, primaryFailure: this.primaryFailure === "NONE" ? "DIAGNOSTIC_OVERFLOW" : this.primaryFailure,
        secondaryCleanupFailure: this.secondaryCleanupFailure, phase: "FAILED", events: [], truncation: "MINIMAL_FALLBACK", droppedEvents: this.droppedEvents });
    }
    return JSON.stringify(projection);
  }
}

export class PortableDestinationError extends Error {
  readonly code: Failure;
  readonly diagnostic: ReturnType<Diagnostics["snapshot"]>;
  constructor(code: Failure, diagnostic: Diagnostics) {
    super(code);
    this.name = "PortableDestinationError";
    this.stack = `PortableDestinationError: ${code}`;
    this.code = code;
    this.diagnostic = JSON.parse(diagnostic.serialize());
  }
}

export function observePortableProcess(child: PortableChild, removeProfile: () => void, clock: PortableClock = portableClock, diagnostic = new Diagnostics(clock)) {
  let spawned = child.pid !== undefined;
  if (spawned) diagnostic.spawn = "SPAWNED";
  let failedSpawn = false;
  let terminal = false;
  let closed = false;
  let settled = false;
  let escalated = false;
  let termSent = false;
  let killSent = false;
  let closing: Promise<void> | undefined;
  let resolveClose: () => void;
  let rejectClose: (error: Error) => void;
  let termTimer: unknown;
  let confirmTimer: unknown;

  const checkTerminal = () => {
    if (!terminal) {
      if (child.exitCode !== null) { terminal = true; diagnostic.terminal = "EXIT_CODE"; }
      else if (child.signalCode !== null) { terminal = true; diagnostic.terminal = "SIGNAL_CODE"; }
      else if (failedSpawn) { terminal = true; diagnostic.terminal = "NO_CHILD_CREATED"; }
    }
    if (child.exitCode !== null) diagnostic.exitClass = Number.isFinite(child.exitCode) ? child.exitCode === 0 ? "ZERO" : "NONZERO" : "OTHER";
    if (child.signalCode !== null) diagnostic.signal = signalCode(child.signalCode);
    return terminal;
  };
  const clearTimers = () => {
    if (termTimer !== undefined) clock.clearTimeout(termTimer);
    if (confirmTimer !== undefined) clock.clearTimeout(confirmTimer);
    termTimer = confirmTimer = undefined;
  };
  const detachCompletion = () => { child.off("spawn", onSpawn); child.off("exit", onExit); };
  const detach = () => {
    detachCompletion(); child.off("close", onClose); child.off("error", onError); diagnostic.detachStreams();
  };
  const finish = () => {
    if (!closing || settled || !checkTerminal()) return;
    settled = true; clearTimers(); detachCompletion();
    diagnostic.cleanup = "REAPED"; diagnostic.event("REAP_CONFIRMED", "REAPED");
    try { removeProfile(); diagnostic.event("PROFILE_REMOVED", "REAPED"); resolveClose(); }
    catch { diagnostic.cleanup = "FAILED"; diagnostic.cleanupFailure("PROFILE_REMOVE_FAILED"); rejectClose(new PortableDestinationError("PROFILE_REMOVE_FAILED", diagnostic)); }
    if (closed || failedSpawn) detach();
  };
  const signal = () => {
    if (!spawned || checkTerminal() || settled) { finish(); return; }
    if (escalated ? killSent : termSent) return;
    if (escalated) killSent = true; else termSent = true;
    if (escalated) diagnostic.killAttempts = 1; else diagnostic.termAttempts = 1;
    try {
      const delivered = child.kill(escalated ? "SIGKILL" : "SIGTERM");
      diagnostic.event(escalated ? delivered ? "KILL_SENT" : "KILL_FAILED" : delivered ? "TERM_SENT" : "TERM_FAILED", escalated ? "KILL" : "TERM");
    } catch (error) { diagnostic.event(escalated ? "KILL_FAILED" : "TERM_FAILED", escalated ? "KILL" : "TERM", errorCode(error)); }
    finish();
  };
  function onSpawn() { spawned = true; diagnostic.spawn = "SPAWNED"; diagnostic.event("SPAWNED", "SPAWN"); if (closing) signal(); }
  function onError(error: unknown) {
    if (!spawned && child.pid === undefined) { failedSpawn = true; diagnostic.spawn = "FAILED"; diagnostic.event("SPAWN_FAILED", "FAILED", errorCode(error)); }
    else diagnostic.event("CHILD_ERROR", diagnostic.phase, errorCode(error));
    finish();
  }
  function onExit() { terminal = true; diagnostic.terminal = "EXIT_EVENT"; checkTerminal(); diagnostic.event("EXIT_OBSERVED", diagnostic.phase); finish(); }
  function onClose() { terminal = true; closed = true; diagnostic.terminal = "CLOSE_EVENT"; checkTerminal(); diagnostic.event("CLOSE_OBSERVED", diagnostic.phase); finish(); if (settled) detach(); }
  child.on("spawn", onSpawn); child.on("error", onError); child.on("exit", onExit); child.on("close", onClose);
  diagnostic.attach(child);
  checkTerminal();

  return {
    snapshot: () => diagnostic.snapshot(),
    serialize: () => diagnostic.serialize(),
    terminal: () => checkTerminal(),
    failedSpawn: () => failedSpawn,
    close: () => {
      if (closing) return closing;
      closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      if (checkTerminal()) finish();
      else {
        termTimer = clock.setTimeout(() => {
          if (checkTerminal()) { finish(); return; }
          escalated = true;
          confirmTimer = clock.setTimeout(() => {
            if (checkTerminal()) { finish(); return; }
            settled = true; clearTimers(); detachCompletion(); diagnostic.cleanup = "RETAINED_UNCONFIRMED";
            diagnostic.cleanupFailure("CLEANUP_UNCONFIRMED"); diagnostic.event("REAP_UNCONFIRMED", "RETAINED"); diagnostic.event("PROFILE_RETAINED", "RETAINED");
            rejectClose(new PortableDestinationError("CLEANUP_UNCONFIRMED", diagnostic));
          }, 2500);
          signal();
        }, 2500);
        signal();
      }
      return closing;
    },
  };
}

export interface PortableReservation { port: number; release(): Promise<void> }
export interface PortableDependencies {
  clock: PortableClock;
  makeDirectory(): string;
  removeDirectory(directory: string): void;
  reservePort(): Promise<PortableReservation>;
  spawn(directory: string, port: number): PortableChild;
  health(url: string): Promise<{ ok: boolean; status: number }>;
}

function dependencies(repoRoot: string): PortableDependencies {
  return {
    clock: portableClock,
    makeDirectory: () => mkdtempSync(path.join(tmpdir(), "rp-portable-browser-")),
    removeDirectory: directory => rmSync(directory, { recursive: true, force: true }),
    reservePort: () => new Promise((resolve, reject) => {
      const socket = createServer();
      socket.on("error", () => {});
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => {
        socket.off("error", reject);
        let releasing: Promise<void> | undefined;
        resolve({
          port: (socket.address() as { port: number }).port,
          release: () => releasing ??= new Promise<void>((done, fail) => socket.close(error => error ? fail(error) : done())),
        });
      });
    }),
    spawn: (directory, port) => {
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
      return spawn("bun", ["src/index.ts", "serve"], {
        cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
        env: { ...inherited, HOME: directory, USERPROFILE: directory, RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1",
          RUNPHANTOM_DB_PATH: path.join(directory, "destination.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"), RUNPHANTOM_CLAUDE_CLI_CHAT: "0" },
      });
    },
    health: url => fetch(url),
  };
}

export async function startPortableDestination(repoRoot: string, controlled?: PortableDependencies) {
  const deps = controlled ?? dependencies(repoRoot);
  const diagnostic = new Diagnostics(deps.clock);
  let directory: string | undefined;
  let reservation: PortableReservation | undefined;
  let reservationReleased = false;
  let owner: ReturnType<typeof observePortableProcess> | undefined;
  let failure: Failure = "SETUP_FAILED";
  try {
    directory = deps.makeDirectory();
    failure = "RESERVATION_FAILED"; diagnostic.phase = "RESERVE";
    reservation = await deps.reservePort();
    diagnostic.event("RESERVATION_OPENED", "RESERVE");
    const port = reservation.port;
    await reservation.release();
    reservationReleased = true;
    diagnostic.event("RESERVATION_RELEASED", "RESERVE");
    failure = "SPAWN_FAILED"; diagnostic.event("SPAWN_REQUESTED", "SPAWN");
    const child = deps.spawn(directory, port);
    const ownedDirectory = directory;
    owner = observePortableProcess(child, () => deps.removeDirectory(ownedDirectory), deps.clock, diagnostic);
    const url = `http://127.0.0.1:${port}`;
    const checkStartup = () => {
      if (owner!.failedSpawn()) { diagnostic.fail("SPAWN_FAILED"); throw new PortableDestinationError("SPAWN_FAILED", diagnostic); }
      if (owner!.terminal()) { diagnostic.fail("EXITED_BEFORE_READY"); throw new PortableDestinationError("EXITED_BEFORE_READY", diagnostic); }
    };
    failure = "HEALTH_NOT_READY"; diagnostic.phase = "HEALTH";
    for (let attempt = 0; attempt < 200; attempt++) {
      checkStartup(); diagnostic.attempts = attempt + 1;
      let ok = false;
      try {
        const response = await deps.health(`${url}/health`);
        ok = response.ok;
        diagnostic.status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
        diagnostic.health = ok ? "OK_HTTP" : "NON_OK_HTTP"; diagnostic.healthCode = "NONE";
        diagnostic.event(ok ? "HEALTH_OK" : "HEALTH_NON_OK", "HEALTH");
      } catch (error) {
        diagnostic.health = "TRANSPORT_ERROR"; diagnostic.status = null; diagnostic.healthCode = errorCode(error);
        diagnostic.event("HEALTH_TRANSPORT", "HEALTH", diagnostic.healthCode);
      }
      checkStartup();
      if (ok) {
        diagnostic.phase = "READY";
        return { url, ...owner, fail: (code: Failure) => diagnostic.fail(code), failure: () => new PortableDestinationError(diagnostic.primaryFailure, diagnostic) };
      }
      await deps.clock.sleep(50);
    }
    diagnostic.fail("HEALTH_NOT_READY");
    throw new PortableDestinationError("HEALTH_NOT_READY", diagnostic);
  } catch (error) {
    diagnostic.fail(failure);
    diagnostic.event(failure === "SPAWN_FAILED" ? "SPAWN_FAILED" : "SETUP_FAILED", "FAILED", errorCode(error));
    if (owner) {
      try { await owner.close(); } catch { /* The owned cleanup recorded only a safe secondary failure. */ }
    } else {
      diagnostic.spawn = "FAILED"; diagnostic.terminal = "NO_CHILD_CREATED";
      if (reservation && !reservationReleased) {
        diagnostic.cleanup = "FAILED"; diagnostic.cleanupFailure("CLEANUP_FAILED"); diagnostic.event("PROFILE_RETAINED", "RETAINED");
      } else if (directory !== undefined) {
        try { deps.removeDirectory(directory); diagnostic.cleanup = "REAPED"; diagnostic.event("PROFILE_REMOVED", "REAPED"); }
        catch { diagnostic.cleanup = "FAILED"; diagnostic.cleanupFailure("PROFILE_REMOVE_FAILED"); }
      }
    }
    throw new PortableDestinationError(diagnostic.primaryFailure, diagnostic);
  }
}

type PortableDestination = Awaited<ReturnType<typeof startPortableDestination>>;
export async function withPortableDestination(repoRoot: string, body: (target: PortableDestination) => Promise<void>, publish: (diagnostic: string) => Promise<void>, controlled?: PortableDependencies) {
  let target: PortableDestination;
  try { target = await startPortableDestination(repoRoot, controlled); }
  catch (error) {
    const safe = error instanceof PortableDestinationError ? error : new PortableDestinationError("SETUP_FAILED", new Diagnostics(controlled?.clock ?? portableClock));
    try { await publish(JSON.stringify(safe.diagnostic)); } catch { /* Preserve the first failure without propagating attachment errors. */ }
    throw safe;
  }
  try { await body(target); } catch { target.fail("PRODUCT_FAILURE"); }
  try { await target.close(); }
  catch { target.fail(target.snapshot().secondaryCleanupFailure === "NONE" ? "CLEANUP_FAILED" : target.snapshot().secondaryCleanupFailure); }
  try { await publish(target.serialize()); } catch { target.fail("SETUP_FAILED"); }
  if (target.snapshot().primaryFailure !== "NONE") throw target.failure();
}
