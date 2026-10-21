import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  observeOwnedChild, ownedClock, OwnedChildCloseError, StreamDigest, count, errorCode, safeNumber,
  type OwnedChild as PortableChild, type OwnedClock as PortableClock, type OwnedChildEvent, type OwnedChildSnapshot,
  type SafeCode, type Signal,
} from "../../tests/helpers/owned-child";
export type { OwnedChild as PortableChild, OwnedClock as PortableClock } from "../../tests/helpers/owned-child";

export const portableClock: PortableClock = ownedClock;

type Failure = "NONE" | "RESERVATION_FAILED" | "SETUP_FAILED" | "SPAWN_FAILED" | "EXITED_BEFORE_READY" | "HEALTH_NOT_READY" | "PRODUCT_FAILURE" | "CLEANUP_FAILED" | "CLEANUP_UNCONFIRMED" | "PROFILE_REMOVE_FAILED" | "DIAGNOSTIC_OVERFLOW";
type Phase = "RESERVE" | "SETUP" | "SPAWN" | "HEALTH" | "READY" | "PRODUCT" | "TERM" | "KILL" | "CONFIRM" | "REAPED" | "RETAINED" | "FAILED";
type Event = "RESERVATION_OPENED" | "RESERVATION_RELEASED" | "SPAWN_REQUESTED" | "SPAWNED" | "SPAWN_FAILED" | "CHILD_ERROR" | "EXIT_OBSERVED" | "CLOSE_OBSERVED" | "HEALTH_OK" | "HEALTH_NON_OK" | "HEALTH_TRANSPORT" | "TERM_SENT" | "TERM_FAILED" | "KILL_SENT" | "KILL_FAILED" | "REAP_CONFIRMED" | "REAP_UNCONFIRMED" | "PROFILE_REMOVED" | "PROFILE_RETAINED" | "SETUP_FAILED";
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
  private owned: ReturnType<typeof observeOwnedChild> | undefined;
  attach(owned: ReturnType<typeof observeOwnedChild>) { this.owned = owned; }
  observe(owned: OwnedChildSnapshot) {
    this.spawn = owned.lifecycle.spawn; this.terminal = owned.lifecycle.terminal; this.cleanup = owned.lifecycle.cleanup;
    this.signal = owned.lifecycle.signal; this.exitClass = owned.lifecycle.exitClass;
    this.termAttempts = owned.metrics.termAttempts; this.killAttempts = owned.metrics.killAttempts;
    this.secondaryCleanupFailure = owned.cleanupFailure;
  }
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
      streams: this.owned?.snapshot().streams ?? { stdout: this.stdout.snapshot(), stderr: this.stderr.snapshot() },
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
  let closeFailure: PortableDestinationError | undefined;
  const onEvent = (event: OwnedChildEvent) => {
    diagnostic.observe(event.snapshot);
    switch (event.kind) {
      case "SPAWNED": diagnostic.event(event.kind, "SPAWN", event.code); break;
      case "SPAWN_FAILED": diagnostic.event(event.kind, "FAILED", event.code); break;
      case "TERM_SENT": case "TERM_FAILED": diagnostic.event(event.kind, "TERM", event.code); break;
      case "KILL_SENT": case "KILL_FAILED": diagnostic.event(event.kind, "KILL", event.code); break;
      case "REAP_CONFIRMED": case "PROFILE_REMOVED": diagnostic.event(event.kind, "REAPED", event.code); break;
      case "REAP_UNCONFIRMED": diagnostic.event(event.kind, "RETAINED", event.code); break;
      case "PROFILE_RETAINED":
        diagnostic.event(event.kind, "RETAINED", event.code);
        closeFailure = new PortableDestinationError("CLEANUP_UNCONFIRMED", diagnostic);
        break;
      case "PROFILE_REMOVE_FAILED": closeFailure = new PortableDestinationError("PROFILE_REMOVE_FAILED", diagnostic); break;
      default: diagnostic.event(event.kind, diagnostic.phase, event.code);
    }
  };
  const owned = observeOwnedChild(child, removeProfile, { clock, termGraceMs: 2500, confirmationMs: 2500, onEvent });
  diagnostic.attach(owned); diagnostic.observe(owned.snapshot());
  let closing: Promise<void> | undefined;
  return {
    snapshot: () => diagnostic.snapshot(),
    serialize: () => diagnostic.serialize(),
    terminal: () => { const terminal = owned.terminal(); diagnostic.observe(owned.snapshot()); return terminal; },
    failedSpawn: () => owned.failedSpawn(),
    close: () => {
      if (closing) return closing;
      let resolveClose: () => void;
      let rejectClose: (error: Error) => void;
      closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      void owned.close().then(() => resolveClose(), error => {
        rejectClose(closeFailure ?? new PortableDestinationError(error instanceof OwnedChildCloseError ? error.code : "CLEANUP_FAILED", diagnostic));
      });
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
