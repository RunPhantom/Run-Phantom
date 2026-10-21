import type { Readable } from "node:stream";
import path from "node:path";
import { HOOK_LIMITS, parseBoundedHookJson, parseClaudeHookInput } from "./shared";

export const CALLBACK_LIMITS = Object.freeze({ stdinEOFMs: 250, lifetimeMs: 1500 });
export type StdinResult = { status: "accepted"; text: string } | { status: "unavailable"; reason: "stdin_limit" | "stdin_deadline" | "stdin_unavailable" | "invalid_utf8" | "aborted" };

/** Acquire actual bytes through EOF; a partial prefix is never admitted as a complete hook. */
export function readClaudeHookStdin(input: Readable, signal: AbortSignal): Promise<StdinResult> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false;
    const finish = (result: StdinResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.pause();
      input.removeListener("data", data); input.removeListener("end", end);
      input.removeListener("error", error); input.removeListener("close", close);
      signal.removeEventListener("abort", abort);
      chunks.length = 0;
      resolve(result);
    };
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) { finish({ status: "unavailable", reason: "stdin_unavailable" }); return; }
      const next = chunk as Uint8Array;
      if (next.byteLength > HOOK_LIMITS.stdinBytes - bytes) { finish({ status: "unavailable", reason: "stdin_limit" }); return; }
      bytes += next.byteLength; chunks.push(Buffer.from(next));
    };
    const end = () => {
      try { finish({ status: "accepted", text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)) }); }
      catch { finish({ status: "unavailable", reason: "invalid_utf8" }); }
    };
    const error = () => finish({ status: "unavailable", reason: "stdin_unavailable" });
    const close = () => { if (!input.readableEnded) error(); };
    const abort = () => finish({ status: "unavailable", reason: "aborted" });
    const timer = setTimeout(() => finish({ status: "unavailable", reason: "stdin_deadline" }), CALLBACK_LIMITS.stdinEOFMs);
    input.on("data", data); input.once("end", end); input.once("error", error); input.once("close", close);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else if (input.readableEnded) end();
    else if (input.destroyed) error();
    else input.resume();
  });
}

/** Only the installed private descriptor and current daemon authority can admit capture. */
export async function runClaudeHookCallback(args: string[], input: Readable = process.stdin): Promise<0> {
  if (args.length !== 4 || args[0] !== "--installation-id" || typeof args[1] !== "string" || !/^[a-f0-9]{32}$/.test(args[1]) || args[2] !== "--capability-file" || typeof args[3] !== "string"
    || !path.isAbsolute(args[3]) || path.normalize(args[3]) !== args[3] || args[3].includes("\0") || Buffer.byteLength(args[3]) > 4096) return 0;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), CALLBACK_LIMITS.lifetimeMs);
  try {
    const acquired = await readClaudeHookStdin(input, controller.signal);
    if (acquired.status !== "accepted" || controller.signal.aborted) return 0;
    const producer = parseBoundedHookJson(acquired.text);
    // Cursor may import Claude settings; its native observer owns these producer events.
    if (producer.status === "accepted" && producer.value && typeof producer.value === "object" && !Array.isArray(producer.value)
      && typeof producer.value.cursor_version === "string") return 0;
    const admitted = parseClaudeHookInput(acquired.text);
    if (admitted.status !== "accepted") return 0;
    const { captureInstalledClaudeHook } = await import("./client");
    await captureInstalledClaudeHook(acquired.text, admitted.value, args[3], args[1], controller.signal);
    return 0;
  } catch { return 0; }
  finally { clearTimeout(timer); input.pause(); }
}
