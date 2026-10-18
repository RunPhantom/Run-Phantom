import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { readClaudeHookStdin, CALLBACK_LIMITS } from "./callback";
import { CODEX_EVENTS, CODEX_LIMITS, codexDigest, codexSnapshotOtlp, decodeCodexRollout, parseCodexHookInput } from "./codex";
import { canonicalPath, decodeRegistration, mergeSettings, privateDirectory, readRegular, stateRoot } from "./codex-registration";
import { acquireCodexLock } from "./codex-lock";

/** A callback is silent, finite, local-only and cannot initialize a database or affect the producer exit. */
export async function runCodexHookCallback(args: string[], input: Readable = process.stdin): Promise<0> {
  let releaseLock: (() => void) | undefined;
  // Reserve cleanup time inside the CLI's unchanged absolute exit deadline.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), CALLBACK_LIMITS.lifetimeMs - 500);
  try {
    if (args.length !== 4 || args[0] !== "--registration-file" || args[2] !== "--installation-id" || !/^[a-f0-9]{32}$/.test(args[3])) return 0;
    const home = await realpath(os.homedir()), root = stateRoot(home), file = args[1];
    if (file !== path.join(root, args[3] + ".json")) return 0;
    await privateDirectory(path.join(home, ".runphantom")); await privateDirectory(root);
    releaseLock = acquireCodexLock(file + ".lock");
    const registration = await readRegular(file, 16384, true), reg = decodeRegistration(registration);
    if (!reg.enabled || reg.id !== args[3] || reg.id !== codexDigest(JSON.stringify([home, reg.workspace])).slice(0, 32)) return 0;
    const raw = await readClaudeHookStdin(input, controller.signal);
    if (raw.status !== "accepted") return 0;
    const hook = parseCodexHookInput(raw.text);
    if (hook.status !== "accepted" || hook.value.cwd !== reg.workspace || !hook.value.transcriptPath) return 0;
    const source = hook.value.transcriptPath, relative = path.relative(reg.sessionsRoot, source);
    if (!canonicalPath(source) || !relative || relative.startsWith("..") || path.isAbsolute(relative) || !source.endsWith(".jsonl")) return 0;
    await privateDirectory(reg.sessionsRoot);
    if (await realpath(source) !== source) return 0;
    for (let dir = path.dirname(source); dir !== reg.sessionsRoot; dir = path.dirname(dir)) {
      const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077) !== 0) return 0;
    }
    const snapshot = decodeCodexRollout(await readRegular(source, CODEX_LIMITS.bytes, true), hook.value);
    if (snapshot.status !== "accepted" || controller.signal.aborted) return 0;
    const settings = await readRegular(path.join(reg.workspace, ".codex", "hooks.json"), 262144, false);
    if (mergeSettings(settings, reg, "install").count !== CODEX_EVENTS.length || await readRegular(file, 16384, true) !== registration || controller.signal.aborted) return 0;
    const response = await fetch(`http://127.0.0.1:${reg.port}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(codexSnapshotOtlp(snapshot.value, reg.id)), signal: controller.signal, redirect: "error" });
    await response.body?.cancel();
  } catch { /* Observation failure never steers the host. */ }
  finally {
    clearTimeout(timer); input.pause();
    releaseLock?.();
  }
  return 0;
}

