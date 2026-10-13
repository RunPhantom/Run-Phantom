import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackRemoteAddress } from "../local-access";
import { HOOK_LIMITS } from "./shared";
import { HookRefusal, HOOK_PROTOCOL, parseHookAdmission, parseHookPublication } from "./protocol";
import { CodingHookStore } from "./store";
import { ContextHookStore } from "./context-store";
import { parseAdmissionV2 } from "./context-v2";
import { parseBoundedHookJson } from "./shared";

export const SERVICE_LIMITS = Object.freeze({ active: 2, queued: 8, bodyMs: 1000, lifetimeMs: 2000, responseBytes: 16384 });
interface Work { request: IncomingMessage; response: ServerResponse; token: string; signal: AbortController; run: () => void; cancel: () => void; }

function acquireBody(request: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, settled = false;
    const finish = (error?: HookRefusal, value?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); request.pause();
      request.removeListener("data", data); request.removeListener("end", end); request.removeListener("error", unavailable); request.removeListener("aborted", unavailable); signal.removeEventListener("abort", abort);
      chunks.length = 0; if (error) reject(error); else resolve(value!);
    };
    const data = (chunk: Buffer) => { if (!Buffer.isBuffer(chunk) || chunk.length > HOOK_LIMITS.stdinBytes - bytes) { finish(new HookRefusal("malformed", 413)); return; } bytes += chunk.length; chunks.push(chunk); };
    const end = () => { try { finish(undefined, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); } catch { finish(new HookRefusal("malformed", 400)); } };
    const unavailable = () => finish(new HookRefusal("unavailable", 400));
    const abort = () => finish(new HookRefusal(signal.reason === "closed" ? "closed" : "deadline", signal.reason === "closed" ? 503 : 408));
    const timer = setTimeout(() => finish(new HookRefusal("deadline", 408)), SERVICE_LIMITS.bodyMs);
    request.on("data", data); request.once("end", end); request.once("error", unavailable); request.once("aborted", unavailable); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else request.resume();
  });
}

/** Raw controller behind existing local guards, before general body parsing. */
export class CodingHookController {
  private closed = false;
  private paused = false;
  private active = new Set<Work>();
  private queued: Work[] = [];
  private pending = new Set<Promise<void>>();
  constructor(readonly store: CodingHookStore, private readonly published: (runId: string) => void = () => {}) {}
  stats() { return { active: this.active.size, queued: this.queued.length, closed: this.closed }; }
  private respond(request: IncomingMessage, response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    let text = JSON.stringify(value); if (Buffer.byteLength(text) > SERVICE_LIMITS.responseBytes) { status = 503; text = '{"status":"unavailable","reason":"unavailable"}'; }
    response.statusCode = status; response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
    if (!request.complete) { response.setHeader("Connection", "close"); response.once("finish", () => request.destroy()); }
    response.end(text);
  }
  private error(request: IncomingMessage, response: ServerResponse, error: unknown) {
    const failure = error instanceof HookRefusal ? error : new HookRefusal("unavailable", 503);
    this.respond(request, response, failure.status, { status: "unavailable", reason: failure.reason });
  }
  handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.pause();
    try {
      if (this.closed || this.paused) throw new HookRefusal("closed", 503);
      const port = request.socket.localPort, host = request.headers.host, allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (!isLoopbackRemoteAddress(request.socket.remoteAddress) || !host || !allowed.includes(host) || request.headers.origin !== undefined && !allowed.map(host => "http://" + host).includes(request.headers.origin)) throw new HookRefusal("unauthorized", 403);
      if (request.method !== "POST" || !["/api/coding-hooks/claude/admission", "/api/coding-hooks/claude/publication"].includes(request.url ?? "")) throw new HookRefusal("malformed", 404);
      if (request.headers["content-type"] !== "application/json") throw new HookRefusal("malformed", 415);
      const header = request.headers.authorization, token = typeof header === "string" ? /^Bearer ([a-f0-9]{64})$/.exec(header)?.[1] : undefined;
      if (!token) throw new HookRefusal("unauthorized", 401);
      if (this.active.size >= SERVICE_LIMITS.active && this.queued.length >= SERVICE_LIMITS.queued) throw new HookRefusal("busy", 429);
      this.store.authenticate(token);
      let finish!: () => void;
      const completion = new Promise<void>(resolve => { finish = resolve; });
      const signal = new AbortController();
      const timer = setTimeout(() => signal.abort("deadline"), SERVICE_LIMITS.lifetimeMs);
      const work: Work = { request, response, token, signal, run: () => {
        if (signal.signal.aborted) { work.cancel(); return; }
        this.active.add(work);
        void (async () => {
          try {
            const raw = await acquireBody(request, signal.signal);
            if (signal.signal.aborted || this.closed || this.paused) throw new HookRefusal(this.closed || this.paused ? "closed" : "deadline", this.closed || this.paused ? 503 : 408);
            if (request.url === "/api/coding-hooks/claude/admission") {
              if (this.store.contextOptions.contextTransport) {
                const candidate = parseBoundedHookJson(raw, 16384);
                if (candidate.status === "accepted" && candidate.value && typeof candidate.value === "object" && !Array.isArray(candidate.value) && candidate.value.version === 2) {
                  const result = new ContextHookStore(this.store).admit(token, parseAdmissionV2(raw));
                  this.respond(request, response, 200, result); return;
                }
              }
              const parsed = parseHookAdmission(raw), admission = this.store.admit(token, parsed.sourceSessionIdentity, { workspaceClaim: parsed.workspaceClaim, projectClaim: parsed.projectClaim });
              this.respond(request, response, 200, { version: HOOK_PROTOCOL, ...admission, coverage: "partial", producerVerified: false, runtimeVerified: false });
            } else {
              if (this.store.contextOptions.contextTransport) {
                const candidate = parseBoundedHookJson(raw);
                if (candidate.status === "accepted" && candidate.value && typeof candidate.value === "object" && !Array.isArray(candidate.value) && candidate.value.version === 2) {
                  const result = new ContextHookStore(this.store).publish(token, raw);
                  try { this.published(result.runId); } catch { /* Notifications confer no capture authority. */ }
                  this.respond(request, response, 200, { version: 2, ...result, coverage: "partial", runtimeVerified: false }); return;
                }
              }
              const publication = parseHookPublication(raw);
              const result = this.store.publish(token, publication, publication.batch);
              try { this.published(result.runId); } catch { /* Notification failure cannot undo a committed observation. */ }
              this.respond(request, response, 200, { version: HOOK_PROTOCOL, ...result, coverage: "partial", runtimeVerified: false });
            }
          } catch (error) { this.error(request, response, error); }
          finally { this.release(work); }
        })();
      }, cancel: () => { this.error(request, response, new HookRefusal(this.closed ? "closed" : "deadline", this.closed ? 503 : 408)); this.release(work); } };
      const release = () => { clearTimeout(timer); signal.signal.removeEventListener("abort", queuedAbort); request.removeListener("aborted", queuedAbort); this.pending.delete(completion); finish(); };
      const queuedAbort = () => { if (!this.active.has(work)) work.cancel(); };
      signal.signal.addEventListener("abort", queuedAbort, { once: true }); request.once("aborted", queuedAbort);
      this.pending.add(completion);
      // release is private to this request, avoiding a detached request/body queue after shutdown.
      this.releases.set(work, release);
      if (this.active.size < SERVICE_LIMITS.active) work.run(); else this.queued.push(work);
      return completion;
    } catch (error) { this.error(request, response, error); return Promise.resolve(); }
  }
  private releases = new Map<Work, () => void>();
  private release(work: Work): void {
    const release = this.releases.get(work); if (!release) return;
    this.releases.delete(work); this.active.delete(work); const index = this.queued.indexOf(work); if (index >= 0) this.queued.splice(index, 1); release();
    if (!this.closed && !this.paused) while (this.active.size < SERVICE_LIMITS.active && this.queued.length) this.queued.shift()!.run();
  }
  pause(): void {
    if (this.closed) throw new HookRefusal("closed", 503);
    this.paused = true;
    for (const work of [...this.active, ...this.queued]) work.signal.abort("closed");
  }
  async drain(): Promise<void> { await Promise.all([...this.pending]); }
  resume(ownerGeneration: string, checkpoint: () => void): void {
    if (!this.paused || this.closed || this.pending.size || this.store.currentOwnerGeneration() !== ownerGeneration) throw new HookRefusal("stale");
    checkpoint(); this.paused = false;
  }
  async close(): Promise<void> { this.closed = true; for (const work of [...this.active, ...this.queued]) work.signal.abort("closed"); await Promise.all([...this.pending]); }
}
