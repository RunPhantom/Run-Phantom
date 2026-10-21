import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { IS_PACKAGED_RUNTIME } from "../version";
import { BROWSER_LIMITS as L, BrowserInputError, browserObject, browserId, browserGeneration, type WorkerOperation } from "./browser-contract";

/** Startup configuration belongs to the local host, never an HTTP/MCP request. */
export interface BrowserHostConfig { moduleEntry?: string; cachePath?: string; cdpEndpoint?: string; artifactRoot?: string; assetOrigins?: string[]; controlOrigins?: string[] }
export interface WorkerReply { ok: boolean; generation: number; result?: unknown; reason?: string }
export interface WorkerProof { workerPid: number; executable: string; cwd: string; browserPid?: number; exited: number | null; signal: string | null; reaped: boolean }
interface Pending { generation: number; resolve(reply: WorkerReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export function browserHostConfig(): BrowserHostConfig {
  return { moduleEntry: process.env.RUNPHANTOM_BROWSER_MODULE, cachePath: process.env.RUNPHANTOM_BROWSER_CACHE,
    cdpEndpoint: process.env.RUNPHANTOM_BROWSER_CDP, artifactRoot: process.env.RUNPHANTOM_BROWSER_ARTIFACTS,
    assetOrigins: process.env.RUNPHANTOM_BROWSER_ASSET_ORIGINS?.split(",").filter(Boolean) };
}
function configuredModule(config: BrowserHostConfig): { entry: string; version: string } | null {
  if (!config.moduleEntry) return null;
  if (!path.isAbsolute(config.moduleEntry) || !existsSync(config.moduleEntry)) throw new Error("Optional browser runtime is unavailable");
  const entry = realpathSync(config.moduleEntry);
  if (!lstatSync(entry).isFile()) throw new Error("Optional browser runtime is unavailable");
  const manifest = path.join(path.dirname(entry), "package.json");
  if (lstatSync(manifest).size > 64 * 1024) throw new Error("Optional browser runtime is incompatible");
  const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "playwright" || !("version" in pkg) || pkg.version !== "1.62.1") throw new Error("Optional browser runtime is incompatible");
  if (config.cachePath && (!path.isAbsolute(config.cachePath) || !lstatSync(config.cachePath).isDirectory())) throw new Error("Optional browser runtime is unavailable");
  return { entry, version: pkg.version };
}
function validateHostConfig(config: BrowserHostConfig): void {
  if (config.cdpEndpoint) {
    const url = new URL(config.cdpEndpoint);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Optional attached browser endpoint is unavailable");
  }
  if (config.assetOrigins && (config.assetOrigins.length > 16 || config.assetOrigins.some(raw => {
    try { const url = new URL(raw); return !["http:", "https:"].includes(url.protocol) || url.origin !== raw || !!(url.username || url.password); } catch { return true; }
  }))) throw new Error("Optional browser asset policy is unavailable");
}

/** One subprocess owns one browser connection. Only closed request IDs can settle calls. */
export class BrowserWorkerClient {
  readonly id = randomBytes(16).toString("hex");
  readonly spool: string;
  readonly proof: WorkerProof;
  onEvent?: (generation: number, event: unknown) => void;
  onState?: (generation: number, state: unknown) => void;
  onLost?: () => void;
  #proc: ChildProcessWithoutNullStreams;
  #nonce = randomBytes(32).toString("hex");
  #pending = new Map<string, Pending>();
  #buffer = Buffer.alloc(0);
  #closing: Promise<void> | null = null;
  #closeStarted?: number;
  #ended: Promise<void>;
  #settled = false;
  constructor(config: BrowserHostConfig, moduleEntry: string, ownership: "owned" | "attached") {
    const root = config.artifactRoot ?? path.join(os.homedir(), ".runphantom", "browser-artifacts");
    if (!path.isAbsolute(root)) throw new BrowserInputError(503, "Private browser artifact directory is unavailable");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.mode & 0o077) throw new BrowserInputError(503, "Private browser artifact directory must be restricted to its owner");
    this.spool = path.join(root, `spool-${this.id}`);
    mkdirSync(this.spool, { mode: 0o700 });
    const sourceEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
    const argv = IS_PACKAGED_RUNTIME ? ["--internal-browser-worker"] : ["--no-env-file", sourceEntry, "--internal-browser-worker"];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && key !== "ANTHROPIC_API_KEY" && key !== "OPENAI_API_KEY"));
    this.#proc = spawn(process.execPath, argv, { cwd: process.cwd(), env: { ...env,
      RUNPHANTOM_BROWSER_WORKER: JSON.stringify({ nonce: this.#nonce, moduleEntry, ownership, spool: this.spool,
        cdpEndpoint: config.cdpEndpoint, assetOrigins: config.assetOrigins ?? [], controlOrigins: config.controlOrigins ?? [] }),
      ...(config.cachePath ? { PLAYWRIGHT_BROWSERS_PATH: config.cachePath } : {}),
      ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RUNPHANTOM_CLAUDE_CLI_CHAT: "0" }, stdio: ["pipe", "pipe", "pipe"] });
    this.proof = { workerPid: this.#proc.pid ?? 0, executable: process.execPath, cwd: process.cwd(), exited: null, signal: null, reaped: false };
    this.#ended = new Promise(resolve => this.#proc.once("close", (code, signal) => {
      this.#settled = true; this.proof.exited = code; this.proof.signal = signal; this.proof.reaped = true;
      this.#fail(); resolve();
    }));
    this.#proc.on("error", () => this.#fail());
    this.#proc.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    // Driver stderr may contain host paths or target console values. Drain, never persist it.
    this.#proc.stderr.on("data", () => {});
    this.#proc.stdin.on("error", () => this.#fail());
  }
  #fail(): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new BrowserInputError(503, "Browser worker disconnected; input dispatch may be unknown")); }
    this.#pending.clear(); this.onLost?.();
  }
  #read(chunk: Buffer): void {
    if (this.#buffer.length + chunk.length > L.FRAME_BYTES * 2) { this.#fail(); this.#proc.kill("SIGTERM"); return; }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let index: number;
    while ((index = this.#buffer.indexOf(10)) !== -1) {
      const raw = this.#buffer.subarray(0, index); this.#buffer = this.#buffer.subarray(index + 1);
      try {
        if (raw.length > L.FRAME_BYTES) throw new Error();
        const frame = browserObject(JSON.parse(raw.toString("utf8")), ["formatVersion", "nonce", "kind", "id", "generation", "ok", "result", "reason", "event", "state", "browserPid"]);
        if (frame.formatVersion !== 1 || frame.nonce !== this.#nonce) throw new Error();
        const generation = browserGeneration(frame.generation);
        if (frame.kind === "event") { browserObject(frame, ["formatVersion", "nonce", "kind", "generation", "event"]); this.onEvent?.(generation, frame.event); continue; }
        if (frame.kind === "state") { browserObject(frame, ["formatVersion", "nonce", "kind", "generation", "state"]); this.onState?.(generation, frame.state); continue; }
        if (frame.kind === "process") {
          browserObject(frame, ["formatVersion", "nonce", "kind", "generation", "browserPid"]);
          if (!Number.isSafeInteger(frame.browserPid) || (frame.browserPid as number) <= 0) throw new Error();
          this.proof.browserPid = frame.browserPid as number; continue;
        }
        browserObject(frame, ["formatVersion", "nonce", "kind", "id", "generation", "ok", "result", "reason"]);
        if (frame.kind !== "reply" || typeof frame.ok !== "boolean" || frame.reason !== undefined && (typeof frame.reason !== "string" || frame.reason.length > 256)) throw new Error();
        const id = browserId(frame.id); const pending = this.#pending.get(id);
        if (!pending) continue; // A cancelled/timed-out request cannot activate a new turn.
        if (generation < pending.generation) throw new Error();
        this.#pending.delete(id); clearTimeout(pending.timer);
        pending.resolve({ ok: frame.ok, generation, ...(frame.result === undefined ? {} : { result: frame.result }), ...(frame.reason === undefined ? {} : { reason: frame.reason as string }) });
      } catch { this.#fail(); this.#proc.kill("SIGTERM"); return; }
    }
    if (this.#buffer.length > L.FRAME_BYTES) { this.#fail(); this.#proc.kill("SIGTERM"); }
  }
  request(operation: WorkerOperation, generation: number, data: unknown, timeout = L.ACTION_MS + 1000): Promise<WorkerReply> {
    if (this.#settled || this.#pending.size >= 2) return Promise.reject(new BrowserInputError(409, "Browser worker is unavailable or busy"));
    const id = randomBytes(16).toString("hex");
    if (operation === "close") this.#closeStarted ??= Date.now();
    const raw = JSON.stringify({ formatVersion: 1, nonce: this.#nonce, id, generation, operation, data }) + "\n";
    if (Buffer.byteLength(raw) > L.FRAME_BYTES) return Promise.reject(new BrowserInputError(400, "Browser request exceeds its frame budget"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new BrowserInputError(504, "Browser operation timed out; input dispatch may be unknown")); }, timeout);
      this.#pending.set(id, { generation, resolve, reject, timer });
      this.#proc.stdin.write(raw);
    });
  }
  close(generation = 0): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (!this.#settled) {
        if (!this.#closeStarted) { try { await this.request("close", generation, {}, L.CLOSE_MS / 2); } catch { /* Await bounded worker cleanup below. */ } }
        if (!this.#settled) this.#proc.kill("SIGTERM");
        const remaining = Math.max(1, L.CLOSE_MS - (Date.now() - (this.#closeStarted ?? Date.now())));
        const timer = setTimeout(() => { if (!this.#settled) this.#proc.kill("SIGKILL"); }, remaining);
        await this.#ended; clearTimeout(timer);
      }
      rmSync(this.spool, { recursive: true, force: true });
    })();
    return this.#closing;
  }
}

export class BrowserProvider {
  #workers = new Set<BrowserWorkerClient>();
  #proofs: WorkerProof[] = [];
  constructor(readonly config: BrowserHostConfig = browserHostConfig()) {}
  status(): { available: boolean; attached: boolean; providerVersion?: string; reason?: string; engines: string[]; qualification: "launch-required"; networkProfile: "bounded-http-v1"; compatibility: "initial-only" } {
    try {
      validateHostConfig(this.config); const module = configuredModule(this.config);
      return { available: !!module, attached: !!module && !!this.config.cdpEndpoint, engines: module ? ["chromium", "firefox", "webkit"] : [], qualification: "launch-required", networkProfile: "bounded-http-v1", compatibility: "initial-only",
        ...(module ? { providerVersion: module.version } : { reason: "Optional browser runtime is not configured" }) };
    } catch { return { available: false, attached: false, engines: [], qualification: "launch-required", networkProfile: "bounded-http-v1", compatibility: "initial-only", reason: "Optional browser runtime is unavailable" }; }
  }
  async start(ownership: "owned" | "attached"): Promise<BrowserWorkerClient> {
    const status = this.status();
    if (!status.available) throw new BrowserInputError(503, status.reason!);
    if (ownership === "attached" && !this.config.cdpEndpoint) throw new BrowserInputError(503, "Optional attached browser is not configured");
    for (const worker of this.#workers) if (worker.proof.reaped) this.#workers.delete(worker);
    if (this.#workers.size >= L.SESSIONS) throw new BrowserInputError(409, "Two browser connections are already allocated");
    const worker = new BrowserWorkerClient(this.config, configuredModule(this.config)!.entry, ownership);
    this.#workers.add(worker); this.#proofs.push(worker.proof); if (this.#proofs.length > 100) this.#proofs.shift(); return worker;
  }
  proofs(): WorkerProof[] { return this.#proofs.map(proof => ({ ...proof })); }
  async close(): Promise<void> { await Promise.all([...this.#workers].map(worker => worker.close())); this.#workers.clear(); }
}
