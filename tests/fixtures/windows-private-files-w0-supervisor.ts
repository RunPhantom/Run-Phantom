import { lstatSync, rmSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { W0_LIMITS } from "./windows-private-files-w0-codec";

export interface W0ChildClose { code: number | null; signal: NodeJS.Signals | null }
interface W0ChildLimits { runMs: number; confirmationMs: number }
const maximum: W0ChildLimits = { runMs: W0_LIMITS.childMs, confirmationMs: 2000 };

/** Direct child/pipes only: an accepted signal never establishes observed closure. */
export function ownW0DiagnosticChild(directory: string, limits: W0ChildLimits = maximum) {
  const identity = lstatSync(directory, { bigint: true }), admitted = performance.now();
  if (!identity.isDirectory() || identity.isSymbolicLink() || !Number.isSafeInteger(limits.runMs) || limits.runMs < 1 || limits.runMs > maximum.runMs
    || !Number.isSafeInteger(limits.confirmationMs) || limits.confirmationMs < 1 || limits.confirmationMs > maximum.confirmationMs) throw new Error("native_supervisor_admission");
  const runDeadline = admitted + limits.runMs, finalDeadline = runDeadline + limits.confirmationMs;
  let child: Pick<ChildProcess, "pid" | "kill"> | undefined, closed: Promise<W0ChildClose> | undefined, observed: W0ChildClose | undefined;
  let observedAt = 0, running = false, removed = false, deadline = false, killAttempted = false, killAccepted: boolean | null = null;
  let primarySet = false, primaryError: unknown, interrupt!: () => void;
  const secondaryErrors: unknown[] = [], interrupted = new Promise<void>(resolve => { interrupt = resolve; });
  const secondary = (error: unknown) => { if (secondaryErrors.length < 8) secondaryErrors.push(error); };
  const signal = () => {
    if (!child || observed || killAttempted) return;
    killAttempted = true;
    try {
      killAccepted = child.kill("SIGKILL");
      if (!killAccepted) secondary(new Error("native_kill_not_accepted"));
    } catch (error) { secondary(error); }
  };
  const recordPrimary = (error: unknown) => { if (!primarySet) { primarySet = true; primaryError = error; } };
  const fail = (error: unknown) => { recordPrimary(error); interrupt(); signal(); };
  async function bounded<T>(promise: Promise<T>, until: number): Promise<{ value: T } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (performance.now() >= until) return null;
    try {
      return await Promise.race([
        promise.then(value => performance.now() <= until ? { value } : null),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, until - performance.now())); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  function adopt(value: Pick<ChildProcess, "pid" | "kill">, receipt: Promise<W0ChildClose>) {
    if (child || removed || running) throw new Error("native_supervisor_already_owned");
    child = value; closed = receipt;
    void receipt.then(value => { observed = value; observedAt = performance.now(); }, error => { secondary(error); fail(error); });
  }
  async function run(): Promise<W0ChildClose> {
    if (!child || !closed || running || removed) throw new Error("native_supervisor_not_owned");
    running = true;
    try {
      const outcome = await bounded(Promise.race([
        closed.then(value => ({ kind: "close" as const, value })),
        interrupted.then(() => ({ kind: "failure" as const })),
      ]), runDeadline);
      if (outcome === null) { deadline = true; fail(new Error("native_child_deadline")); }
      if (primarySet) throw primaryError;
      if (!outcome || outcome.value.kind !== "close" || observedAt > runDeadline) throw new Error("native_child_deadline");
      return outcome.value.value;
    } catch (error) { fail(error); throw primaryError; }
  }
  const ownership = () => ({ pid: child?.pid ?? null, exitCode: observed?.code ?? null, signal: observed?.signal ?? null, reaped: observed !== undefined,
    deadline, killAttempted, killAccepted, secondaryErrorCount: secondaryErrors.length, rootRemovedAfterReap: removed,
    cleanupUnconfirmed: !!child && !observed, retainedSyntheticRoot: removed ? null : path.basename(directory), elapsedMs: Math.round(performance.now() - admitted) });
  async function cleanup() {
    if (removed) return ownership();
    if (child && !observed && closed) {
      signal();
      try { await bounded(closed, Math.min(finalDeadline, performance.now() + limits.confirmationMs)); }
      catch (error) { secondary(error); }
    }
    if (child && !observed) { secondary(new Error("native_child_cleanup_unconfirmed")); return ownership(); }
    try {
      const current = lstatSync(directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) throw new Error("native_synthetic_root_identity_changed");
      rmSync(directory, { recursive: true, force: false }); removed = true;
    } catch (error) { secondary(error); }
    return ownership();
  }
  function throwFailure() {
    const failures = [...(primarySet ? [primaryError] : []), ...secondaryErrors];
    if (failures.length > 1) throw new AggregateError(failures, "native_diagnostic_and_cleanup_failed");
    if (failures.length === 1) throw failures[0];
  }
  return { adopt, run, fail, recordPrimary, cleanup, ownership, throwFailure, get primaryError() { return primaryError; }, get secondaryErrors() { return [...secondaryErrors]; } };
}
