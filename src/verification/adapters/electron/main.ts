import { randomBytes } from "node:crypto";
import { BrowserArtifactStore } from "../../browser-artifacts";
import { BROWSER_LIMITS, parseBrowserTarget } from "../../browser-contract";
import { evaluatePredicate } from "../../predicates";
import { parsePredicate } from "../../validation";
import { sanitizeWithReport } from "../../serialization";
import type { Predicate, RuntimeEvent, Verdict } from "../../protocol";
import { dataObject, ELECTRON_CHANNEL, ELECTRON_LIMITS, ElectronVerificationError, parseElectronRequest, type ElectronFailure, type ElectronOperation } from "./contract";

type Listener = (...args: any[]) => void;
export interface CooperatingWindow {
  isDestroyed(): boolean;
  getContentBounds(): { width: number; height: number };
  webContents: {
    mainFrame: { url: string }; isDestroyed(): boolean; getURL(): string;
    getLastWebPreferences(): { contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean };
    on(event: string, listener: Listener): unknown; removeListener(event: string, listener: Listener): unknown;
    send(channel: string, value: unknown): void;
    capturePage(): Promise<{ isEmpty(): boolean; getSize(): { width: number; height: number }; toPNG(): Buffer }>;
  };
}
export interface ElectronMainHost {
  ipcMain: { on(channel: string, listener: Listener): unknown; removeListener(channel: string, listener: Listener): unknown };
}
export interface ElectronCloseResult {
  authority: "retired";
  nativeCapture: "settled" | "unconfirmed";
  pendingNativeCaptures: number;
  nativeCancellation: "unsupported";
}
export const createElectronAuthority = (): string => randomBytes(32).toString("hex");
const failureCodes: ElectronFailure[] = ["INVALID_REQUEST", "STALE_DOCUMENT", "CLOSED", "BUSY", "TIMEOUT", "UNAVAILABLE",
  "TARGET_MISSING", "TARGET_AMBIGUOUS", "PRIVATE_TARGET", "UNSUPPORTED_TARGET", "CAPTURE_FAILED"];
interface Pending { id: number; generation: number; operation: ElectronOperation; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** The host passes one actual BrowserWindow; renderer-supplied IDs/URLs never select authority. */
export class CooperatingElectronSession {
  readonly backend = "cooperating-electron";
  readonly generation = 1;
  #closed = false;
  #sequence = 0;
  #pending?: Pending;
  #captures = new Set<Promise<unknown>>();
  #retireCapture?: () => void;
  #closing?: Promise<ElectronCloseResult>;
  #reply: Listener;
  #retire: Listener;
  constructor(readonly host: ElectronMainHost, readonly window: CooperatingWindow, readonly token: string,
    readonly documentUrl: string, readonly artifacts: BrowserArtifactStore) {
    const prefs = window.webContents.getLastWebPreferences();
    const url = new URL(documentUrl);
    if (!/^[a-f0-9]{64}$/.test(token) || window.isDestroyed() || window.webContents.isDestroyed()
      || window.webContents.getURL() !== documentUrl || !["file:", "http:", "https:"].includes(url.protocol)
      || url.username || url.password || prefs.contextIsolation !== true || prefs.nodeIntegration !== false || prefs.sandbox !== true) throw new ElectronVerificationError("UNAVAILABLE");
    this.#reply = (event: { sender?: unknown; senderFrame?: unknown }, value: unknown) => {
      if (this.#closed || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      const pending = this.#pending;
      if (!pending || window.webContents.getURL() !== documentUrl || window.webContents.mainFrame.url !== documentUrl) return;
      try {
        const reply = dataObject(value, ["token", "id", "generation", "ok", "result", "code"]);
        if (reply.token !== token || reply.id !== pending.id || reply.generation !== pending.generation || typeof reply.ok !== "boolean") return;
        if (!reply.ok) {
          if (!failureCodes.includes(reply.code as ElectronFailure)) throw new Error();
          this.#finish(new ElectronVerificationError(reply.code as ElectronFailure)); return;
        }
        const result = dataObject(reply.result, pending.operation.type === "read" ? ["count", "text"] : ["dispatched"]);
        if (pending.operation.type === "read") {
          if (!Number.isSafeInteger(result.count) || (result.count as number) < 0 || (result.count as number) > 1000
            || typeof result.text !== "string" || result.text.length > ELECTRON_LIMITS.text) throw new Error();
          const safe = sanitizeWithReport(result.text);
          this.#finish(undefined, { count: result.count, text: safe.value, complete: !safe.redacted && !safe.truncation });
        } else {
          if (result.dispatched !== true) throw new Error();
          this.#finish(undefined, { dispatch: "completed", inputMode: "cooperating-dom", generation: this.generation });
        }
      } catch { this.#finish(new ElectronVerificationError("UNAVAILABLE")); }
    };
    this.#retire = () => { void this.close(); };
    host.ipcMain.on(ELECTRON_CHANNEL + ":reply", this.#reply);
    for (const event of ["did-start-navigation", "render-process-gone", "destroyed"]) window.webContents.on(event, this.#retire);
  }
  #finish(error?: Error, result?: unknown): void {
    const pending = this.#pending; if (!pending) return;
    this.#pending = undefined; clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(result);
  }
  #current(generation: number): void {
    if (this.#closed || this.window.isDestroyed() || this.window.webContents.isDestroyed()) throw new ElectronVerificationError("CLOSED");
    if (generation !== this.generation || this.window.webContents.getURL() !== this.documentUrl) throw new ElectronVerificationError("STALE_DOCUMENT");
  }
  request(generation: number, operation: ElectronOperation): Promise<unknown> {
    this.#current(generation);
    if (this.#pending || this.#captures.size) throw new ElectronVerificationError("BUSY");
    if (this.#sequence >= ELECTRON_LIMITS.calls) throw new ElectronVerificationError("UNAVAILABLE");
    const request = parseElectronRequest({ token: this.token, id: ++this.#sequence, generation, operation });
    parseBrowserTarget({ kind: "css", selector: request.operation.selector });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#finish(new ElectronVerificationError("TIMEOUT")); void this.close(); }, ELECTRON_LIMITS.requestMs);
      this.#pending = { id: request.id, generation, operation, resolve, reject, timer };
      try { this.window.webContents.send(ELECTRON_CHANNEL + ":request", request); }
      catch { this.#finish(new ElectronVerificationError("UNAVAILABLE")); }
    });
  }
  async check(generation: number, input: unknown): Promise<{ backend: string; inputMode: "cooperating-dom"; verdict: Verdict }> {
    const predicate = parsePredicate(input), events: RuntimeEvent[] = [];
    const read = async (part: Predicate): Promise<void> => {
      if (part.kind === "allOf" || part.kind === "anyOf") { for (const child of part.predicates) await read(child); }
      else if (part.kind === "element") {
        const result = await this.request(generation, { type: "read", selector: part.selector }) as { count: number; complete: boolean };
        events.push({ t: Date.now(), type: "dom", data: { selector: part.selector, count: result.count }, ...(result.complete ? {} : { truncated: true }) });
      }
    };
    await read(predicate); this.#current(generation);
    return { backend: this.backend, inputMode: "cooperating-dom", verdict: evaluatePredicate(predicate, {
      events, coverage: { dom: true, network: false, console: false, state: false, signal: false, route: false }, complete: true, settled: false,
    }) };
  }
  async capture(generation: number, rawConsent: true) {
    this.#current(generation);
    if (rawConsent !== true) throw new ElectronVerificationError("INVALID_REQUEST");
    if (this.#pending || this.#captures.size) throw new ElectronVerificationError("BUSY");
    if (++this.#sequence > ELECTRON_LIMITS.calls) throw new ElectronVerificationError("UNAVAILABLE");
    const bounds = this.window.getContentBounds();
    if (bounds.width < 1 || bounds.height < 1 || bounds.width > BROWSER_LIMITS.WIDTH || bounds.height > BROWSER_LIMITS.HEIGHT) throw new ElectronVerificationError("CAPTURE_FAILED");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The native promise remains owned after the caller's timeout or retirement.
      // Electron provides no cancellation API for capturePage.
      const nativeCapture = this.window.webContents.capturePage();
      this.#captures.add(nativeCapture);
      const settled = () => { this.#captures.delete(nativeCapture); };
      void nativeCapture.then(settled, settled);
      const image = await Promise.race([nativeCapture, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ElectronVerificationError("TIMEOUT")), ELECTRON_LIMITS.requestMs);
      }), new Promise<never>((_resolve, reject) => {
        this.#retireCapture = () => reject(new ElectronVerificationError("CLOSED"));
      })]);
      this.#current(generation);
      const size = image.getSize();
      if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width > BROWSER_LIMITS.WIDTH || size.height > BROWSER_LIMITS.HEIGHT) throw new ElectronVerificationError("CAPTURE_FAILED");
      const artifact = this.artifacts.admit(image.toPNG(), { kind: "screenshot", raw: true, rawConsent: true,
        maskScope: "none", engine: "chromium", ownership: "attached", generation });
      return { backend: this.backend, source: "webContents.capturePage", artifact };
    } catch (error) {
      if (error instanceof ElectronVerificationError && error.code === "TIMEOUT") void this.close();
      throw error instanceof ElectronVerificationError ? error : new ElectronVerificationError("CAPTURE_FAILED");
    }
    finally { clearTimeout(timer); this.#retireCapture = undefined; }
  }
  close(waitMs: number = ELECTRON_LIMITS.closeMs): Promise<ElectronCloseResult> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > ELECTRON_LIMITS.closeMs) return Promise.reject(new ElectronVerificationError("INVALID_REQUEST"));
    if (!this.#closed) {
      this.#closed = true; this.#finish(new ElectronVerificationError("CLOSED"));
      this.#retireCapture?.();
      this.host.ipcMain.removeListener(ELECTRON_CHANNEL + ":reply", this.#reply);
      for (const event of ["did-start-navigation", "render-process-gone", "destroyed"]) this.window.webContents.removeListener(event, this.#retire);
    }
    // One shared deadline/result prevents concurrent callers extending retirement.
    this.#closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...this.#captures]), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
        const pendingNativeCaptures = this.#captures.size;
        return { authority: "retired" as const, nativeCapture: pendingNativeCaptures ? "unconfirmed" as const : "settled" as const,
          pendingNativeCaptures, nativeCancellation: "unsupported" as const };
      } finally { clearTimeout(timer); }
    })();
    return this.#closing;
  }
}
