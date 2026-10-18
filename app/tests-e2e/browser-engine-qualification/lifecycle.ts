import type { ChildProcess } from "node:child_process";
export interface CleanupResult { stage: string; completed: boolean; error?: string }
export function processGone(pid: number): boolean { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }
export async function waitForOwned(check: () => boolean, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Owned resource condition exceeded deadline"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
export async function cleanupStages(stages: Array<{ stage: string; timeout?: number; close: () => unknown }>, milliseconds = 5000): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  for (const { stage, close, timeout } of stages) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.resolve().then(close), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Cleanup stage exceeded deadline")), timeout ?? milliseconds); })]); results.push({ stage, completed: true }); }
    catch (error) { results.push({ stage, completed: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }); }
    finally { clearTimeout(timer); }
  }
  return results;
}
export async function reapOwnedProcess(child: ChildProcess, descendants: readonly number[], closed: () => boolean, milliseconds = 5000): Promise<{ forced: boolean; closeObserved: boolean }> {
  let forced = false;
  if (child.pid && !processGone(child.pid)) {
    child.kill("SIGTERM");
    try { await waitForOwned(() => processGone(child.pid!), milliseconds); }
    catch { forced = true; child.kill("SIGKILL"); }
  }
  // Descendants may inherit pipes and prevent close even after the parent exits.
  try { await waitForOwned(() => descendants.every(processGone), milliseconds); }
  catch {
    forced = true;
    for (const pid of descendants) if (!processGone(pid)) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (!processGone(pid)) throw error; } }
  }
  await waitForOwned(() => (!child.pid || processGone(child.pid)) && descendants.every(processGone), milliseconds);
  await waitForOwned(closed, milliseconds);
  return { forced, closeObserved: closed() };
}
export function preserveFixtureFailure(primary: Error | undefined, cleanup: readonly CleanupResult[]): void {
  const failed = cleanup.filter(result => !result.completed);
  if (failed.length) throw new AggregateError([...(primary === undefined ? [] : [primary]), ...failed.map(result => new Error(`${result.stage}: ${result.error}`))], "F47 fixture primary/cleanup failures");
  if (primary !== undefined) throw primary;
}
