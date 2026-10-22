import { closeSync, fstatSync, lstatSync, openSync, unlinkSync } from "node:fs";
const lifecycle: NodeJS.EventEmitter = process;

/** Cooperative lock: exit cleanup owns an actual FD, never a guessed stale path or PID. */
export function acquireCodexLock(file: string): () => void {
  let fd: number | undefined;
  const release = () => {
    lifecycle.removeListener("exit", release);
    const owned = fd; fd = undefined;
    if (owned === undefined) return;
    try {
      const opened = fstatSync(owned, { bigint: true }), current = lstatSync(file, { bigint: true });
      if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1n && opened.dev === current.dev && opened.ino === current.ino) unlinkSync(file);
    } catch { /* A missing or replaced path grants no cleanup authority. */ }
    finally { try { closeSync(owned); } catch { /* The host exit remains silent. */ } }
  };
  lifecycle.on("exit", release);
  try { fd = openSync(file, "wx", 0o600); return release; }
  catch (error) { lifecycle.removeListener("exit", release); throw error; }
}
