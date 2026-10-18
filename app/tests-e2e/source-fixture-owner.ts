import { count, errorCode, observeOwnedChild, ownedClock, safeNumber, OwnedChildCloseError,
  type OwnedChild, type OwnedChildEvent, type OwnedChildSnapshot, type OwnedClock, type SafeCode } from "../../tests/helpers/owned-child";

export type SourceRequestPhase = "DETAIL_COMPLETION" | "DOCUMENT_LOAD";
const sourceCodes = ["SPAWN_FAILED", "HEALTH_EXITED", "HEALTH_TIMEOUT", "READINESS_FAILED", "CLEANUP_FAILED"] as const;
type SourceFixtureCode = typeof sourceCodes[number];
const statuses = ["passed", "failed", "timedOut", "skipped", "interrupted", "UNKNOWN"] as const;
type Status = typeof statuses[number];
type Data = Record<string, unknown>;
type Emit = (text: string) => void;
const PREFIX = "SOURCE_FIXTURE_V1 ";
const LIMIT = 8192 - Buffer.byteLength(PREFIX) - 1;
const data = <T extends object>(value: T): T => Object.assign(Object.create(null), value);
const list = <T>(value: T[]): T[] => Object.setPrototypeOf(value, null);
const status = (value: unknown): Status => statuses.find(allowed => allowed === value) ?? "UNKNOWN";
const quiet = (run: () => void) => { try { run(); } catch { /* Diagnostics have no lifecycle authority. */ } };
const consoleSink: Emit = text => { console.error(text); };

function own(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try { const field = Object.getOwnPropertyDescriptor(value, key); return field && "value" in field ? field.value : undefined; }
  catch { return undefined; }
}
function sourceCode(error: unknown): SourceFixtureCode {
  const code = own(error, "code");
  return sourceCodes.find(allowed => allowed === code) ?? "READINESS_FAILED";
}
export class SourceFixtureError extends Error {
  readonly code: SourceFixtureCode;
  constructor(code: SourceFixtureCode) {
    const safe = sourceCodes.find(allowed => allowed === code) ?? "READINESS_FAILED";
    super(safe); this.name = "SourceFixtureError"; this.code = safe; this.stack = `SourceFixtureError: ${safe}`;
  }
}
function cleanupError(error: unknown): Error {
  const code = own(error, "code");
  return code === "CLEANUP_UNCONFIRMED" || code === "PROFILE_REMOVE_FAILED"
    ? new OwnedChildCloseError(code) : new SourceFixtureError("CLEANUP_FAILED");
}
// Forward the captured value exactly; cleanup presence is tracked separately.
function rethrow(value: unknown): never {
  throw value;
}
function encode(value: object): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new Error("SOURCE_FIXTURE_ENCODING_FAILED");
  return text;
}
function publish(receipt: Data, emit: Emit) {
  quiet(() => {
    let text = encode(receipt);
    if (Buffer.byteLength(text) > LIMIT) {
      const requests = receipt.requests as Record<SourceRequestPhase, Data>;
      const compactRequest = (value: Data) => data({ started: value.started, fulfilled: value.fulfilled, rejected: value.rejected,
        pending: value.pending, lastOutcome: value.lastOutcome, lastDurationMs: value.lastDurationMs, lastCode: value.lastCode });
      text = encode(data({ version: 1, scope: "STANDARD_SOURCE", fixtureStage: receipt.fixtureStage, use: receipt.use,
        primary: receipt.primary, afterClose: receipt.afterClose, health: receipt.health,
        requests: data({ DETAIL_COMPLETION: compactRequest(requests.DETAIL_COMPLETION), DOCUMENT_LOAD: compactRequest(requests.DOCUMENT_LOAD) }),
        detailOmitted: true }));
    }
    if (Buffer.byteLength(text) > LIMIT) throw new Error("SOURCE_FIXTURE_RECEIPT_LIMIT");
    emit(PREFIX + text);
  });
}
function unavailable() { return data({ availability: "UNAVAILABLE", bytes: null, sha256: null, phase: "UNAVAILABLE" }); }
function projectChild(value: OwnedChildSnapshot, streams: { stdout: boolean; stderr: boolean }) {
  const stream = (name: "stdout" | "stderr") => streams[name]
    ? data({ availability: "ATTACHED", bytes: count(value.streams[name].bytes), sha256: value.streams[name].sha256, phase: value.streams[name].phase })
    : unavailable();
  return data({ availability: "ATTACHED", lifecycle: data({ spawn: value.lifecycle.spawn, terminal: value.lifecycle.terminal,
    cleanup: value.lifecycle.cleanup, signal: value.lifecycle.signal, exitClass: value.lifecycle.exitClass }),
    metrics: data({ termAttempts: count(value.metrics.termAttempts), killAttempts: count(value.metrics.killAttempts) }),
    streams: data({ stdout: stream("stdout"), stderr: stream("stderr") }), cleanupFailure: value.cleanupFailure });
}
function unknownChild(captured: boolean) {
  return data({ availability: captured ? "UNAVAILABLE" : "NOT_ATTACHED", lifecycle: null, metrics: null,
    streams: data({ stdout: unavailable(), stderr: unavailable() }), cleanupFailure: captured ? "UNKNOWN" : "RETAINED_NO_CAPTURE" });
}
function newRequest() {
  return { started: 0, fulfilled: 0, rejected: 0, pending: 0,
    lastOutcome: "NONE" as "NONE" | "PENDING" | "FULFILLED" | "REJECTED", lastDurationMs: 0,
    lastCode: "NONE" as SafeCode, lastRejectedChild: null as Data | null };
}
type Request = ReturnType<typeof newRequest>;
type Observer = { begin: (phase: SourceRequestPhase) => number; complete: (phase: SourceRequestPhase, started: number, rejected: boolean, error?: unknown) => void };
const observations = new WeakMap<object, Observer>();

export function spawnSourceFixture<T>(spawnAction: () => T, emit: Emit = consoleSink): T {
  try { return spawnAction(); }
  catch (error) {
    const child = unknownChild(false);
    publish(data({ version: 1, scope: "STANDARD_SOURCE", fixtureStage: "ACQUIRE",
      use: data({ result: "NOT_REACHED", actual: "UNKNOWN", expected: "UNKNOWN" }),
      primary: data({ kind: "SETUP", code: "SPAWN_FAILED", errorClass: errorCode(error) }), beforeClose: child, afterClose: child,
      health: data({ attempts: 0, ok: 0, nonOk: 0, rejected: 0, lastResult: "NONE", lastCode: "NONE" }),
      requests: data({ DETAIL_COMPLETION: data(newRequest()), DOCUMENT_LOAD: data(newRequest()) }),
      events: list([]), droppedEvents: 0, detailOmitted: false, snapshotOrigin: "FINALIZER" }), emit);
    throw new SourceFixtureError("SPAWN_FAILED");
  }
}

export function createSourceFixtureOwner(child: OwnedChild, removeProfile: () => void,
  controls?: { clock: OwnedClock; emit: Emit }) {
  const clock = controls?.clock ?? ownedClock, emit = controls?.emit ?? consoleSink;
  const attached = { stdout: child.stdout !== null, stderr: child.stderr !== null };
  const events: Array<{ kind: OwnedChildEvent["kind"]; code: SafeCode; elapsedMs: number }> = [];
  let droppedEvents = 0, sealed = false, selected = false;
  const now = () => { try { return safeNumber(clock.now()); } catch { return 0; } };
  const health = { attempts: 0, ok: 0, nonOk: 0, rejected: 0,
    lastResult: "NONE" as "NONE" | "OK" | "NON_OK" | "REJECTED", lastCode: "NONE" as SafeCode };
  const requests = { DETAIL_COMPLETION: newRequest(), DOCUMENT_LOAD: newRequest() };
  const core = observeOwnedChild(child, removeProfile, { clock, termGraceMs: 2500, confirmationMs: 2500,
    onEvent: event => {
      if (sealed) return;
      events.push({ kind: event.kind, code: event.code, elapsedMs: safeNumber(event.elapsedMs) });
      if (events.length > 16) { events.shift(); droppedEvents = count(droppedEvents + 1); }
    } });
  const snapshot = () => projectChild(core.snapshot(), attached);
  const observer: Observer = {
    begin: phase => {
      if (sealed) return 0;
      selected = true;
      const request = requests[phase]; request.started = count(request.started + 1); request.pending = count(request.pending + 1);
      request.lastOutcome = "PENDING"; return now();
    },
    complete: (phase, started, rejected, error) => {
      if (sealed) return;
      const request = requests[phase]; request.pending = count(Math.max(0, request.pending - 1));
      request.lastDurationMs = safeNumber(now() - started);
      if (rejected) {
        request.rejected = count(request.rejected + 1); request.lastOutcome = "REJECTED";
        request.lastCode = errorCode(error); request.lastRejectedChild = snapshot();
      } else { request.fulfilled = count(request.fulfilled + 1); request.lastOutcome = "FULFILLED"; request.lastCode = "NONE"; }
    },
  };
  const requestProjection = (request: Request) => data({ ...request });
  return {
    close: core.close,
    healthAttempt: () => quiet(() => { if (!sealed) health.attempts = count(health.attempts + 1); }),
    healthResponse: (ok: boolean) => quiet(() => {
      if (sealed) return;
      health.lastCode = "NONE";
      if (ok === true) { health.ok = count(health.ok + 1); health.lastResult = "OK"; }
      else { health.nonOk = count(health.nonOk + 1); health.lastResult = "NON_OK"; }
    }),
    healthRejection: (error: unknown) => quiet(() => {
      if (!sealed) { health.rejected = count(health.rejected + 1); health.lastResult = "REJECTED"; health.lastCode = errorCode(error); }
    }),
    run: async <T extends object>(options: { handle: T; ready: () => Promise<void>; use: (handle: T) => Promise<void>;
      afterUseStatus: () => { actual: unknown; expected: unknown } }): Promise<void> => {
      let stage: "HEALTH" | "USE" = "HEALTH", useResult: "NOT_REACHED" | "RESOLVED" | "THREW" = "NOT_REACHED";
      let actual: Status = "UNKNOWN", expected: Status = "UNKNOWN", caught = false, primary: unknown;
      let primaryKind = "NONE", primaryCode: string = "NONE", primaryClass: SafeCode = "NONE";
      let cleanupFailed = false, cleanup: Error | undefined, bodyFailure = false;
      observations.set(options.handle, observer);
      try {
        await options.ready(); stage = "USE";
        await options.use(options.handle); useResult = "RESOLVED";
        quiet(() => {
          const observed = options.afterUseStatus(); actual = status(own(observed, "actual")); expected = status(own(observed, "expected"));
        });
        bodyFailure = actual !== "UNKNOWN" && expected !== "UNKNOWN" && actual !== expected;
      } catch (error) {
        caught = true; primaryClass = errorCode(error);
        if (stage === "USE") { useResult = "THREW"; primary = error; primaryKind = "USE_THROW"; }
        else { primaryCode = sourceCode(error); primary = new SourceFixtureError(primaryCode as SourceFixtureCode); primaryKind = "SETUP"; }
      } finally {
        observations.delete(options.handle);
        let beforeClose: Data = unknownChild(true), afterClose: Data = unknownChild(true);
        quiet(() => { beforeClose = snapshot(); });
        try { await core.close(); }
        catch (error) { cleanupFailed = true; cleanup = cleanupError(error); }
        quiet(() => { afterClose = snapshot(); });
        sealed = true;
        if (!caught) {
          if (bodyFailure) primaryKind = "FRAMEWORK_BODY";
          else if (cleanupFailed) {
            primaryKind = "CLEANUP";
            const code = own(cleanup, "code");
            primaryCode = code === "CLEANUP_UNCONFIRMED" || code === "PROFILE_REMOVE_FAILED" ? code : "CLEANUP_FAILED";
          } else if (useResult === "RESOLVED" && (actual === "UNKNOWN" || expected === "UNKNOWN")) primaryKind = "UNKNOWN_STATUS";
        }
        if (selected || caught || bodyFailure || cleanupFailed || primaryKind === "UNKNOWN_STATUS") quiet(() => {
          publish(data({ version: 1, scope: "STANDARD_SOURCE", fixtureStage: "FINALIZED",
            use: data({ result: useResult, actual, expected }), primary: data({ kind: primaryKind, code: primaryCode, errorClass: primaryClass }),
            beforeClose, afterClose, health: data({ ...health }),
            requests: data({ DETAIL_COMPLETION: requestProjection(requests.DETAIL_COMPLETION), DOCUMENT_LOAD: requestProjection(requests.DOCUMENT_LOAD) }),
            events: list(events.map(event => data({ ...event }))), droppedEvents, detailOmitted: false, snapshotOrigin: "FINALIZER" }), emit);
        });
      }
      if (caught) throw primary;
      if (cleanupFailed && !bodyFailure) rethrow(cleanup);
    },
  };
}

export function observeSourceRequest<T>(handle: object | undefined, phase: SourceRequestPhase, operation: () => Promise<T>): Promise<T> {
  const observer = handle && observations.get(handle);
  if (!observer || (phase !== "DETAIL_COMPLETION" && phase !== "DOCUMENT_LOAD")) return operation();
  let started = 0;
  quiet(() => { started = observer.begin(phase); });
  try {
    return operation().then(value => { quiet(() => observer.complete(phase, started, false)); return value; },
      error => { quiet(() => observer.complete(phase, started, true, error)); throw error; });
  } catch (error) { quiet(() => observer.complete(phase, started, true, error)); throw error; }
}
