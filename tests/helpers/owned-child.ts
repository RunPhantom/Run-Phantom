import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export interface OwnedChild extends EventEmitter {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface OwnedClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  sleep(ms: number): Promise<void>;
}

export const ownedClock: OwnedClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

const errorCodes = ["NONE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EADDRINUSE", "EACCES", "EPERM", "ENOENT", "EPIPE", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "OTHER"] as const;
export type SafeCode = typeof errorCodes[number];
const signals = ["NONE", "SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT", "SIGHUP", "SIGABRT", "SIGSEGV", "SIGBREAK", "OTHER"] as const;
export type Signal = typeof signals[number];
export const safeNumber = (value: number) => Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
export const count = (value: number) => Math.floor(safeNumber(value));
function dataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try { const property = Object.getOwnPropertyDescriptor(value, key); return property && "value" in property ? property.value : undefined; }
  catch { return undefined; }
}
export function errorCode(error: unknown): SafeCode {
  const direct = dataProperty(error, "code");
  const code = direct === undefined ? dataProperty(dataProperty(error, "cause"), "code") : direct;
  return errorCodes.find(allowed => allowed === code) ?? "OTHER";
}
function signalCode(signal: unknown): Signal { return signals.find(allowed => allowed === signal) ?? "OTHER"; }

export class StreamDigest {
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

type OwnedChildFailure = "PROFILE_REMOVE_FAILED" | "CLEANUP_UNCONFIRMED";
export interface OwnedChildSnapshot {
  lifecycle: {
    spawn: "PENDING" | "SPAWNED" | "FAILED";
    terminal: "NONE" | "EXIT_CODE" | "SIGNAL_CODE" | "EXIT_EVENT" | "CLOSE_EVENT" | "NO_CHILD_CREATED";
    cleanup: "NONE" | "REAPED" | "RETAINED_UNCONFIRMED" | "FAILED";
    signal: Signal;
    exitClass: "NONE" | "ZERO" | "NONZERO" | "OTHER";
  };
  metrics: { termAttempts: number; killAttempts: number };
  streams: { stdout: ReturnType<StreamDigest["snapshot"]>; stderr: ReturnType<StreamDigest["snapshot"]> };
  cleanupFailure: "NONE" | OwnedChildFailure;
}
export interface OwnedChildEvent {
  kind: "SPAWNED" | "SPAWN_FAILED" | "CHILD_ERROR" | "EXIT_OBSERVED" | "CLOSE_OBSERVED" | "REAP_CONFIRMED" | "PROFILE_REMOVED" | "PROFILE_REMOVE_FAILED" | "TERM_SENT" | "TERM_FAILED" | "KILL_SENT" | "KILL_FAILED" | "REAP_UNCONFIRMED" | "PROFILE_RETAINED";
  code: SafeCode;
  elapsedMs: number;
  snapshot: OwnedChildSnapshot;
}
export interface OwnedChildOptions {
  clock: OwnedClock;
  termGraceMs: number;
  confirmationMs: number;
  onEvent?: (event: OwnedChildEvent) => void;
}
export class OwnedChildCloseError extends Error {
  constructor(readonly code: OwnedChildFailure) {
    super(code);
    this.name = "OwnedChildCloseError";
    this.stack = `OwnedChildCloseError: ${code}`;
  }
}

export function observeOwnedChild(child: OwnedChild, removeProfile: () => void, options: OwnedChildOptions) {
  const clock = options.clock;
  const started = safeNumber(clock.now());
  const lifecycle: OwnedChildSnapshot["lifecycle"] = { spawn: "PENDING", terminal: "NONE", cleanup: "NONE", signal: "NONE", exitClass: "NONE" };
  const metrics = { termAttempts: 0, killAttempts: 0 };
  let cleanupFailure: OwnedChildSnapshot["cleanupFailure"] = "NONE";
  let stdout = new StreamDigest(null); let stderr = new StreamDigest(null);
  function snapshot(): OwnedChildSnapshot {
    return {
      lifecycle: { spawn: lifecycle.spawn, terminal: lifecycle.terminal, cleanup: lifecycle.cleanup, signal: lifecycle.signal, exitClass: lifecycle.exitClass },
      metrics: { termAttempts: metrics.termAttempts, killAttempts: metrics.killAttempts },
      streams: { stdout: stdout.snapshot(), stderr: stderr.snapshot() },
      cleanupFailure,
    };
  }
  function publish(kind: OwnedChildEvent["kind"], code: SafeCode = "NONE") {
    // Diagnostics never decide terminal state or interrupt owned cleanup.
    try { options.onEvent?.({ kind, code, elapsedMs: safeNumber(clock.now() - started), snapshot: snapshot() }); } catch {}
  }
  let spawned = child.pid !== undefined;
  if (spawned) lifecycle.spawn = "SPAWNED";
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
      if (child.exitCode !== null) { terminal = true; lifecycle.terminal = "EXIT_CODE"; }
      else if (child.signalCode !== null) { terminal = true; lifecycle.terminal = "SIGNAL_CODE"; }
      else if (failedSpawn) { terminal = true; lifecycle.terminal = "NO_CHILD_CREATED"; }
    }
    if (child.exitCode !== null) lifecycle.exitClass = Number.isFinite(child.exitCode) ? child.exitCode === 0 ? "ZERO" : "NONZERO" : "OTHER";
    if (child.signalCode !== null) lifecycle.signal = signalCode(child.signalCode);
    return terminal;
  };
  const clearTimers = () => {
    if (termTimer !== undefined) clock.clearTimeout(termTimer);
    if (confirmTimer !== undefined) clock.clearTimeout(confirmTimer);
    termTimer = confirmTimer = undefined;
  };
  const detachCompletion = () => { child.off("spawn", onSpawn); child.off("exit", onExit); };
  const detach = () => {
    detachCompletion(); child.off("close", onClose); child.off("error", onError); stdout.close(); stderr.close();
  };
  const finish = () => {
    if (!closing || settled || !checkTerminal()) return;
    settled = true; clearTimers(); detachCompletion();
    lifecycle.cleanup = "REAPED"; publish("REAP_CONFIRMED");
    try { removeProfile(); publish("PROFILE_REMOVED"); resolveClose(); }
    catch { lifecycle.cleanup = "FAILED"; cleanupFailure = "PROFILE_REMOVE_FAILED"; publish("PROFILE_REMOVE_FAILED"); rejectClose(new OwnedChildCloseError("PROFILE_REMOVE_FAILED")); }
    if (closed || failedSpawn) detach();
  };
  const signal = () => {
    if (!spawned || checkTerminal() || settled) { finish(); return; }
    if (escalated ? killSent : termSent) return;
    if (escalated) killSent = true; else termSent = true;
    if (escalated) metrics.killAttempts = 1; else metrics.termAttempts = 1;
    try {
      const delivered = child.kill(escalated ? "SIGKILL" : "SIGTERM");
      publish(escalated ? delivered ? "KILL_SENT" : "KILL_FAILED" : delivered ? "TERM_SENT" : "TERM_FAILED");
    } catch (error) { publish(escalated ? "KILL_FAILED" : "TERM_FAILED", errorCode(error)); }
    finish();
  };
  function onSpawn() { spawned = true; lifecycle.spawn = "SPAWNED"; publish("SPAWNED"); if (closing) signal(); }
  function onError(error: unknown) {
    if (!spawned && child.pid === undefined) { failedSpawn = true; lifecycle.spawn = "FAILED"; publish("SPAWN_FAILED", errorCode(error)); }
    else publish("CHILD_ERROR", errorCode(error));
    finish();
  }
  function onExit() { terminal = true; lifecycle.terminal = "EXIT_EVENT"; checkTerminal(); publish("EXIT_OBSERVED"); finish(); }
  function onClose() { terminal = true; closed = true; lifecycle.terminal = "CLOSE_EVENT"; checkTerminal(); publish("CLOSE_OBSERVED"); finish(); if (settled) detach(); }
  child.on("spawn", onSpawn); child.on("error", onError); child.on("exit", onExit); child.on("close", onClose);
  stdout = new StreamDigest(child.stdout); stderr = new StreamDigest(child.stderr);
  checkTerminal();

  return {
    snapshot,
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
            settled = true; clearTimers(); detachCompletion(); lifecycle.cleanup = "RETAINED_UNCONFIRMED";
            cleanupFailure = "CLEANUP_UNCONFIRMED"; publish("REAP_UNCONFIRMED"); publish("PROFILE_RETAINED");
            rejectClose(new OwnedChildCloseError("CLEANUP_UNCONFIRMED"));
          }, options.confirmationMs);
          signal();
        }, options.termGraceMs);
        signal();
      }
      return closing;
    },
  };
}

