import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { TauriError, record, TAURI_LIMITS, type TauriRequest, type TauriTransport } from "./contract";

const PREFIX = "RP_TAURI_V1 ";
const MAX_LINE = TAURI_LIMITS.pngBytes * 2 + 4096;
/** Only the host launcher supplies this already-owned packaged fixture child. */
export class TauriProcessTransport implements TauriTransport {
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: TauriError) => void; detach: () => void }>();
  readonly #terminal: Promise<void>;
  #exited = false;
  #closed = false;
  #close?: Promise<boolean>;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.#terminal = new Promise(resolve => {
      child.once("close", () => { this.#exited = true; this.#rejectAll(); resolve(); });
    });
    child.once("error", () => this.#rejectAll());
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => this.#rejectAll());
    let buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_LINE) { buffer = Buffer.alloc(0); this.#closed = true; this.#rejectAll(); void this.close(); return; }
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        if (!line.subarray(0, PREFIX.length).equals(Buffer.from(PREFIX))) continue;
        try {
          const value = record(JSON.parse(line.subarray(PREFIX.length).toString("utf8")));
          if (typeof value.id !== "string") continue;
          const pending = this.#pending.get(value.id); if (!pending) continue;
          if (Object.hasOwn(value, "pngHex")) {
            if (typeof value.pngHex !== "string" || value.pngHex.length > TAURI_LIMITS.pngBytes * 2 || !/^(?:[0-9a-f]{2})+$/.test(value.pngHex)) throw new TauriError("invalid-reply");
            value.png = Buffer.from(value.pngHex, "hex"); delete value.pngHex;
          }
          this.#pending.delete(value.id); pending.detach(); pending.resolve(value);
        } catch { this.#rejectAll("invalid-reply"); }
      }
    });
    // Native logs never become artifacts, diagnostics, or retained raw tails.
    child.stderr.on("data", () => undefined);
  }
  #rejectAll(code: "unavailable" | "invalid-reply" = "unavailable"): void {
    for (const pending of this.#pending.values()) { pending.detach(); pending.reject(new TauriError(code)); }
    this.#pending.clear();
  }
  exchange(request: TauriRequest, signal: AbortSignal): Promise<unknown> {
    if (this.#closed || this.#exited) return Promise.reject(new TauriError("closed"));
    if (signal.aborted) return Promise.reject(new TauriError("cancelled"));
    if (this.#pending.size >= 1) return Promise.reject(new TauriError("busy"));
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.#pending.delete(request.id); reject(new TauriError("cancelled")); };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(request.id, { resolve, reject, detach: () => signal.removeEventListener("abort", abort) });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, error => {
        if (error) { const pending = this.#pending.get(request.id); this.#pending.delete(request.id); pending?.detach(); pending?.reject(new TauriError("unavailable")); }
      });
    });
  }
  close(): Promise<boolean> {
    if (this.#close) return this.#close;
    this.#closed = true; this.#rejectAll();
    const wait = async (ms: number): Promise<boolean> => {
      if (this.#exited) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([this.#terminal.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
      finally { clearTimeout(timer); }
    };
    this.#close = (async () => {
      if (this.#exited) return true;
      try { this.child.kill("SIGTERM"); } catch { /* A signal is not terminal confirmation. */ }
      if (await wait(2500)) return true;
      try { this.child.kill("SIGKILL"); } catch { /* Retain ownership if terminal confirmation is absent. */ }
      return wait(2500);
    })(); return this.#close;
  }
}
