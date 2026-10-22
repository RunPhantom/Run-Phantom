import type { ChildProcess } from "node:child_process";

export const ELECTRON_PROCESS_DEADLINES = { termMs: 30000, killMs: 35000, finalMs: 40000, pollMs: 25 } as const;
interface Deadlines { termMs: number; killMs: number; finalMs: number; pollMs: number }
export interface ElectronTerminal {
  status: "confirmed" | "unconfirmed";
  leaderClosed: boolean;
  groupEmpty: boolean;
  code: number | null;
  signal: string | null;
  launchFailed: boolean;
  attemptedSignals: { signal: "SIGTERM" | "SIGKILL"; accepted: boolean }[];
}

/** Only the caller's newly spawned, detached fixture group may supply these controls. */
export function waitForElectronTerminal(child: ChildProcess,
  group: { isGone(): boolean; signal(signal: "SIGTERM" | "SIGKILL"): boolean },
  deadlines: Deadlines = ELECTRON_PROCESS_DEADLINES): Promise<ElectronTerminal> {
  if (!Object.values(deadlines).every(Number.isSafeInteger) || deadlines.termMs < 1 || deadlines.termMs >= deadlines.killMs
    || deadlines.killMs >= deadlines.finalMs || deadlines.finalMs > ELECTRON_PROCESS_DEADLINES.finalMs
    || deadlines.pollMs < 1 || deadlines.pollMs > 1000) throw new Error("Invalid owned Electron process deadline");
  return new Promise(resolve => {
    let done = false, leaderClosed = false, launchFailed = false, code: number | null = null, signal: string | null = null;
    const attemptedSignals: ElectronTerminal["attemptedSignals"] = [];
    let observedGroupGone = false;
    const groupEmpty = () => {
      if (!observedGroupGone) { try { observedGroupGone = group.isGone(); } catch { /* Unknown is not empty. */ } }
      return observedGroupGone;
    };
    const finish = (final = false) => {
      if (done) return;
      const empty = groupEmpty();
      if (!final && (!leaderClosed || !empty)) return;
      done = true;
      clearTimeout(term); clearTimeout(kill); clearTimeout(last); clearInterval(poll);
      child.removeListener("error", error); child.removeListener("close", closed);
      const confirmed = leaderClosed && empty;
      if (!confirmed) {
        // A signal request is not reaping. Release only this runner's handles so
        // its final deadline remains finite; the caller must retain the profile.
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      }
      resolve({ status: confirmed ? "confirmed" : "unconfirmed", leaderClosed, groupEmpty: empty,
        code, signal, launchFailed, attemptedSignals });
    };
    const error = () => { launchFailed = true; };
    const closed = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      leaderClosed = true; code = exitCode; signal = exitSignal; finish();
    };
    const send = (value: "SIGTERM" | "SIGKILL") => {
      // Once the owned group disappears, never reacquire a reused numeric ID.
      if (groupEmpty()) return;
      let accepted = false; try { accepted = group.signal(value); } catch { /* Unknown remains unconfirmed. */ }
      attemptedSignals.push({ signal: value, accepted });
    };
    const term = setTimeout(() => send("SIGTERM"), deadlines.termMs);
    const kill = setTimeout(() => send("SIGKILL"), deadlines.killMs);
    const last = setTimeout(() => finish(true), deadlines.finalMs);
    const poll = setInterval(() => finish(), deadlines.pollMs);
    child.on("error", error); child.on("close", closed);
  });
}
