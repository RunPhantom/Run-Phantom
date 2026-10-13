import { acquireCodingHookOwner, CodingHookOwnerRefusal } from "../coding-hooks/owner";
import { COMPARISON_LIMITS } from "./comparison-protocol";

export interface ComparisonOwnerFence { readonly birth: string; readonly generation: number }
export class ComparisonOwnerRefusal extends Error {
  readonly code: "busy" | "inactive";
  constructor(readonly reason: "busy" | "inactive") { super(reason); this.code = reason; }
}
const DRAIN_MS = 5000;
/** Trusted owner startup only. Acquisition precedes recovery; no route installs this foundation yet. */
export async function acquireComparisonOwner(databasePath: string, signal?: AbortSignal) {
  const lease = await acquireCodingHookOwner(databasePath, signal, "prompt-comparisons");
  let generation = 1, closing = false, drained: Promise<void> | undefined, closeResult: Promise<void> | undefined;
  const active = new Set<{ controller: AbortController; done: Promise<void> }>();
  const assertCurrent = (fence: ComparisonOwnerFence): void => {
    if (closing || !lease.isActive() || fence.birth !== lease.birth || fence.generation !== generation) throw new ComparisonOwnerRefusal("inactive");
  };
  return Object.freeze({
    capture(): ComparisonOwnerFence { const fence = Object.freeze({ birth: lease.birth, generation }); assertCurrent(fence); return fence; },
    assertCurrent,
    async dispatch<T>(fence: ComparisonOwnerFence, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      assertCurrent(fence);
      if (active.size >= COMPARISON_LIMITS.active) throw new ComparisonOwnerRefusal("busy");
      const controller = new AbortController(); let settled!: () => void;
      const entry = { controller, done: new Promise<void>(resolve => { settled = resolve; }) }; active.add(entry);
      try { return await task(controller.signal); }
      finally { active.delete(entry); settled(); }
    },
    close(): Promise<void> {
      if (closeResult) return closeResult;
      closing = true; generation++;
      for (const entry of active) entry.controller.abort();
      // The live lease remains held after a drain deadline until every dispatch really settles.
      drained = Promise.all([...active].map(entry => entry.done)).then(() => lease.release());
      closeResult = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new CodingHookOwnerRefusal("deadline")), DRAIN_MS);
        drained!.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error instanceof Error ? error : new CodingHookOwnerRefusal("unavailable")); });
      });
      return closeResult;
    },
    drained(): Promise<void> { return drained ?? Promise.resolve(); },
  });
}
