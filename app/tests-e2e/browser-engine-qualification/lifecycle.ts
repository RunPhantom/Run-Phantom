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

export interface OwnedHttpServer {
  server: import("node:http").Server;
  sockets: Set<import("node:net").Socket>;
  listeningObserved: boolean;
  connectionsObserved: number;
  closeObserved: boolean;
  closeCallbackObserved: boolean;
  fallbackUsed: boolean;
}
export function observeOwnedHttpServer(server: import("node:http").Server): OwnedHttpServer {
  const owned: OwnedHttpServer = { server, sockets: new Set(), listeningObserved: false, connectionsObserved: 0, closeObserved: false, closeCallbackObserved: false, fallbackUsed: false };
  server.once("listening", () => { owned.listeningObserved = true; });
  server.once("close", () => { owned.closeObserved = true; });
  server.on("connection", socket => { owned.connectionsObserved++; owned.sockets.add(socket); socket.once("close", () => owned.sockets.delete(socket)); });
  return owned;
}
export function httpServerProof(owned: OwnedHttpServer) {
  return { listeningObserved: owned.listeningObserved, connectionsObserved: owned.connectionsObserved, listening: owned.server.listening, closeObserved: owned.closeObserved,
    closeCallbackObserved: owned.closeCallbackObserved, fallbackUsed: owned.fallbackUsed, liveSockets: owned.sockets.size };
}
export async function closeOwnedHttpServer(owned: OwnedHttpServer, milliseconds = 3500): Promise<ReturnType<typeof httpServerProof>> {
  if (!owned.listeningObserved) throw new Error("HTTP listener acquisition was not observed; closure is unproved");
  let fallback: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = new Promise<void>((resolve, reject) => {
      owned.server.close(error => { owned.closeCallbackObserved = true; if (error) reject(error); else resolve(); });
    });
    // One graceful close owns the callback. Force only pending connections, without a second close call.
    fallback = setTimeout(() => { owned.fallbackUsed = true; owned.server.closeAllConnections(); }, Math.floor(milliseconds / 2));
    await Promise.race([closed, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("Owned HTTP close exceeded deadline")), milliseconds); })]);
    await waitForOwned(() => !owned.server.listening && owned.closeObserved && owned.sockets.size === 0, 500);
    return httpServerProof(owned);
  } finally { clearTimeout(fallback); clearTimeout(deadline); }
}
