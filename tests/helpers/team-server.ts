import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  count, errorCode, observeOwnedChild, ownedClock, OwnedChildCloseError, safeNumber, StreamDigest,
  type OwnedChild, type OwnedChildEvent, type OwnedChildSnapshot, type OwnedClock, type SafeCode,
} from "./owned-child";

const root = path.resolve(__dirname, "../..");

type Failure = "NONE" | "SETUP_FAILED" | "RESERVATION_FAILED" | "SPAWN_FAILED" | "EXITED_BEFORE_READY" | "SESSION_NOT_READY" | "CLEANUP_FAILED" | "CLEANUP_UNCONFIRMED" | "PROFILE_REMOVE_FAILED" | "DIAGNOSTIC_OVERFLOW";
type Phase = "SETUP" | "RESERVE" | "SPAWN" | "SESSION" | "READY" | "TERM" | "KILL" | "REAPED" | "RETAINED" | "FAILED";
type Event = OwnedChildEvent["kind"] | "RESERVATION_OPENED" | "RESERVATION_RELEASED" | "SPAWN_REQUESTED" | "SESSION_OK" | "SESSION_NON_200" | "SESSION_TRANSPORT" | "SETUP_FAILED";

export interface TeamPortReservation { port: number; release(): Promise<void> }
export interface TeamFixtureOperations {
  clock: OwnedClock;
  makeDirectory(prefix: string): string;
  removeDirectory(profile: string): void;
  reservePort(): Promise<TeamPortReservation>;
  spawn(command: string, args: string[], options: SpawnOptions): OwnedChild;
  probe(url: string, options: { signal: AbortSignal }): Promise<{ status: number }>;
}
// Separate from operations: the sink receives only the bounded safe serialization.
export type TeamFixtureReceiptSink = (serializedDiagnostic: string) => void;

class Diagnostics {
  primaryFailure: Failure = "NONE";
  secondaryCleanupFailure: Failure = "NONE";
  phase: Phase = "SETUP";
  lifecycle: OwnedChildSnapshot["lifecycle"] = { spawn: "PENDING", terminal: "NONE", cleanup: "NONE", signal: "NONE", exitClass: "NONE" };
  probe: { observation: "NONE" | "OK_HTTP" | "NON_200_HTTP" | "TRANSPORT_ERROR"; status: number | null; code: SafeCode } = { observation: "NONE", status: null, code: "NONE" };
  attempts = 0;
  private termAttempts = 0;
  private killAttempts = 0;
  private started: number;
  private events: { event: Event; phase: Phase; elapsedMs: number; code: SafeCode }[] = [];
  private droppedEvents = 0;
  private emptyOut = new StreamDigest(null);
  private emptyErr = new StreamDigest(null);
  private owned: ReturnType<typeof observeOwnedChild> | undefined;
  constructor(private clock: OwnedClock) { this.started = safeNumber(clock.now()); }
  attach(owned: ReturnType<typeof observeOwnedChild>) { this.owned = owned; this.observe(owned.snapshot()); }
  observe(snapshot: OwnedChildSnapshot) {
    this.lifecycle = { ...snapshot.lifecycle };
    this.termAttempts = snapshot.metrics.termAttempts; this.killAttempts = snapshot.metrics.killAttempts;
    this.secondaryCleanupFailure = snapshot.cleanupFailure;
  }
  fail(code: Failure) { if (this.primaryFailure === "NONE") this.primaryFailure = code; }
  elapsed() { return safeNumber(this.clock.now() - this.started); }
  event(event: Event, phase: Phase, code: SafeCode = "NONE") {
    this.phase = phase;
    if (this.events.length === 32) { this.events.shift(); this.droppedEvents = count(this.droppedEvents + 1); }
    this.events.push({ event, phase, elapsedMs: this.elapsed(), code });
  }
  ownedEvent(event: OwnedChildEvent) {
    this.observe(event.snapshot);
    let phase = this.phase;
    switch (event.kind) {
      case "SPAWNED": phase = "SPAWN"; break;
      case "SPAWN_FAILED": case "PROFILE_REMOVE_FAILED": phase = "FAILED"; break;
      case "TERM_SENT": case "TERM_FAILED": phase = "TERM"; break;
      case "KILL_SENT": case "KILL_FAILED": phase = "KILL"; break;
      case "REAP_CONFIRMED": case "PROFILE_REMOVED": phase = "REAPED"; break;
      case "REAP_UNCONFIRMED": case "PROFILE_RETAINED": phase = "RETAINED"; break;
    }
    this.event(event.kind, phase, event.code);
  }
  snapshot() {
    return {
      schemaVersion: 1 as const, fixture: "TEAM" as const,
      primaryFailure: this.primaryFailure, secondaryCleanupFailure: this.secondaryCleanupFailure, phase: this.phase,
      lifecycle: { ...this.lifecycle }, probe: { ...this.probe },
      metrics: { attempts: Math.min(400, count(this.attempts)), termAttempts: Math.min(1, count(this.termAttempts)), killAttempts: Math.min(1, count(this.killAttempts)), elapsedMs: this.elapsed() },
      streams: this.owned?.snapshot().streams ?? { stdout: this.emptyOut.snapshot(), stderr: this.emptyErr.snapshot() },
      events: this.events.map(event => ({ ...event })),
      truncation: this.droppedEvents ? "EVENTS_DROPPED" : "NONE", droppedEvents: this.droppedEvents,
    };
  }
  serialize() {
    const projection = this.snapshot();
    while (Buffer.byteLength(JSON.stringify(projection), "utf8") > 16384 && projection.events.length) {
      projection.events.shift(); projection.droppedEvents = count(projection.droppedEvents + 1); projection.truncation = "EVENTS_DROPPED";
    }
    if (Buffer.byteLength(JSON.stringify(projection), "utf8") > 16384) {
      return JSON.stringify({ schemaVersion: 1, fixture: "TEAM", primaryFailure: this.primaryFailure === "NONE" ? "DIAGNOSTIC_OVERFLOW" : this.primaryFailure,
        secondaryCleanupFailure: this.secondaryCleanupFailure, phase: "FAILED", events: [], truncation: "MINIMAL_FALLBACK", droppedEvents: this.droppedEvents });
    }
    return JSON.stringify(projection);
  }
}

export class TeamFixtureError extends Error {
  readonly diagnostic: ReturnType<Diagnostics["snapshot"]>;
  constructor(readonly code: Failure, diagnostic: Diagnostics) {
    super(code);
    this.name = "TeamFixtureError";
    this.stack = `TeamFixtureError: ${code}`;
    this.diagnostic = JSON.parse(diagnostic.serialize());
  }
}

function teamOperations(): TeamFixtureOperations {
  return {
    clock: ownedClock,
    makeDirectory: prefix => mkdtempSync(prefix),
    removeDirectory: profile => rmSync(profile, { recursive: true, force: true }),
    reservePort: () => new Promise((resolve, reject) => {
      const socket = createServer();
      socket.on("error", () => {});
      const failed = (error: Error) => socket.close(() => reject(error));
      socket.once("error", failed);
      socket.listen(0, "127.0.0.1", () => {
        socket.off("error", failed);
        let releasing: Promise<void> | undefined;
        resolve({
          port: (socket.address() as { port: number }).port,
          release: () => releasing ??= new Promise<void>((done, fail) => socket.close(error => error ? fail(error) : done())),
        });
      });
    }),
    spawn: (command, args, options) => spawn(command, args, options),
    probe: (url, options) => fetch(url, options),
  };
}

export async function startTeamFixture(name = "integration", binary?: string, controlled?: TeamFixtureOperations, receiptSink: TeamFixtureReceiptSink = serialized => console.error(`[runphantom-team-fixture] ${serialized}`)) {
  const operations = controlled ?? teamOperations();
  const diagnostic = new Diagnostics(operations.clock);
  let published = false;
  const publish = (error: TeamFixtureError) => {
    if (published) return;
    published = true;
    // Latch before calling external code; a throwing/reentrant sink has no cleanup authority.
    try { receiptSink(JSON.stringify(error.diagnostic)); } catch {}
  };
  let profile: string | undefined;
  let reservation: TeamPortReservation | undefined;
  let reservationReleased = false;
  let owned: ReturnType<typeof observeOwnedChild> | undefined;
  let close: (() => Promise<void>) | undefined;
  let startupFailed = false;
  let failure: Failure = "SETUP_FAILED";
  try {
    profile = operations.makeDirectory(path.join(tmpdir(), `runphantom-team-${name}-`));
    const dataDir = path.join(profile, "team");
    failure = "RESERVATION_FAILED"; diagnostic.phase = "RESERVE";
    reservation = await operations.reservePort();
    diagnostic.event("RESERVATION_OPENED", "RESERVE");
    const port = reservation.port;
    await reservation.release();
    reservationReleased = true;
    diagnostic.event("RESERVATION_RELEASED", "RESERVE");
    failure = "SETUP_FAILED";
    const url = `http://127.0.0.1:${port}`;
    const setupCode = randomBytes(32).toString("base64url");
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
    const runtime = process.versions.bun ? process.execPath : "bun";
    failure = "SPAWN_FAILED"; diagnostic.event("SPAWN_REQUESTED", "SPAWN");
    const child = operations.spawn(binary ?? runtime,
      binary ? ["team", "serve"] : [path.join(root, "src/index.ts"), "team", "serve"], {
        cwd: profile,
        env: {
          ...inherited,
          HOME: profile,
          USERPROFILE: profile,
          RUNPHANTOM_TEAM_DATA_DIR: dataDir,
          RUNPHANTOM_TEAM_PORT: String(port),
          RUNPHANTOM_TEAM_BIND_HOST: "127.0.0.1",
          RUNPHANTOM_TEAM_PUBLIC_ORIGIN: url,
          RUNPHANTOM_TEAM_BOOTSTRAP_CODE: setupCode,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    const ownedProfile = profile;
    owned = observeOwnedChild(child, () => operations.removeDirectory(ownedProfile), {
      clock: operations.clock, termGraceMs: 2000, confirmationMs: 2500, onEvent: event => diagnostic.ownedEvent(event),
    });
    diagnostic.attach(owned);
    let output = "";
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32_768); };
    const detachCapture = () => { child.stdout?.off("data", capture); child.stderr?.off("data", capture); child.off("close", detachCapture); };
    child.once("close", detachCapture);
    child.stdout?.on("data", capture); child.stderr?.on("data", capture);
    let closing: Promise<void> | undefined;
    const owner = owned;
    close = () => {
      if (closing) return closing;
      let resolveClose: () => void;
      let rejectClose: (error: TeamFixtureError) => void;
      closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      void owner.close().then(() => resolveClose(), error => {
        diagnostic.observe(owner.snapshot());
        const code = error instanceof OwnedChildCloseError ? error.code : "CLEANUP_FAILED";
        diagnostic.secondaryCleanupFailure = code; diagnostic.fail(code);
        const safe = new TeamFixtureError(diagnostic.primaryFailure, diagnostic);
        if (!startupFailed) publish(safe);
        rejectClose(safe);
      });
      return closing;
    };
    const checkStartup = () => {
      const terminal = owner.terminal(); diagnostic.observe(owner.snapshot());
      const code = owner.failedSpawn() ? "SPAWN_FAILED" : terminal ? "EXITED_BEFORE_READY" : undefined;
      if (code) { diagnostic.fail(code); throw new TeamFixtureError(code, diagnostic); }
    };
    failure = "SESSION_NOT_READY"; diagnostic.phase = "SESSION";
    for (let attempt = 0; attempt < 400; attempt++) {
      checkStartup(); diagnostic.attempts = attempt + 1;
      let ready = false;
      try {
        const response = await operations.probe(`${url}/api/team/session`, { signal: AbortSignal.timeout(500) });
        ready = response.status === 200;
        diagnostic.probe = { observation: ready ? "OK_HTTP" : "NON_200_HTTP", status: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null, code: "NONE" };
        diagnostic.event(ready ? "SESSION_OK" : "SESSION_NON_200", "SESSION");
      } catch (error) {
        diagnostic.probe = { observation: "TRANSPORT_ERROR", status: null, code: errorCode(error) };
        diagnostic.event("SESSION_TRANSPORT", "SESSION", diagnostic.probe.code);
      }
      checkStartup();
      if (ready) {
        diagnostic.phase = "READY";
        return { url, profile, dataDir, setupCode, close, logs: () => output };
      }
      await operations.clock.sleep(25);
    }
    checkStartup();
    diagnostic.fail("SESSION_NOT_READY");
    throw new TeamFixtureError("SESSION_NOT_READY", diagnostic);
  } catch (error) {
    startupFailed = true;
    diagnostic.fail(failure);
    diagnostic.event("SETUP_FAILED", "FAILED", errorCode(error));
    if (close) {
      try { await close(); } catch { /* Owned cleanup has recorded only the safe secondary failure. */ }
    } else {
      diagnostic.lifecycle.spawn = "FAILED"; diagnostic.lifecycle.terminal = "NO_CHILD_CREATED";
      if (reservation && !reservationReleased) {
        try { await reservation.release(); reservationReleased = true; diagnostic.event("RESERVATION_RELEASED", "RESERVE"); }
        catch (releaseError) {
          diagnostic.lifecycle.cleanup = "FAILED"; diagnostic.secondaryCleanupFailure = "CLEANUP_FAILED";
          diagnostic.event("PROFILE_RETAINED", "RETAINED", errorCode(releaseError));
        }
      }
      if ((!reservation || reservationReleased) && profile !== undefined) {
        try { operations.removeDirectory(profile); diagnostic.lifecycle.cleanup = "REAPED"; diagnostic.event("PROFILE_REMOVED", "REAPED"); }
        catch (removeError) {
          diagnostic.lifecycle.cleanup = "FAILED"; diagnostic.secondaryCleanupFailure = "PROFILE_REMOVE_FAILED";
          diagnostic.event("PROFILE_REMOVE_FAILED", "FAILED", errorCode(removeError));
        }
      }
    }
    const safe = new TeamFixtureError(diagnostic.primaryFailure, diagnostic);
    publish(safe);
    throw safe;
  }
}

export type TeamFixture = Awaited<ReturnType<typeof startTeamFixture>>;
