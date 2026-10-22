import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { lstatSync, mkdtempSync, opendirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { closeDb, getDrizzleDb } from "../../src/db";
import { createServer } from "../../src/server";
import { runMcpServer, type McpServerHandle } from "../../src/mcp/index";

export type FixtureStage = "client-close" | "mcp-close" | "transport-close" | "http-close" | "db-close" | "env-restore" | "directory-remove";
export interface StageReceipt {
  stage: FixtureStage;
  acquired: boolean;
  attempted: boolean;
  succeeded: boolean;
  failed: boolean;
}
export interface CleanupFailure { stage: FixtureStage; error: unknown }
interface Inventory {
  exists: boolean | null;
  members: Array<{ label: string; type: "file" | "directory" | "symlink" | "other"; size: number }>;
  truncated: boolean;
  issues: Array<{ operation: "open" | "read" | "stat" | "close"; code?: string }>;
}
interface RemovalDiagnostics {
  fixture: string;
  database: "evaluations.db";
  before: Inventory;
  after: Inventory;
  stages: StageReceipt[];
  error: { code?: string; syscall?: string; path: "<fixture>"; issues: Array<"code" | "syscall"> };
}
export interface CleanupReport {
  stages: StageReceipt[];
  failures: CleanupFailure[];
  removalDiagnostics?: RemovalDiagnostics;
  diagnosticIssues?: Array<"removal-diagnostics">;
}
export interface FixtureControls {
  afterHttpReady?: (fixture: EvaluationMcpFixture) => void | Promise<void>;
  closeClient?: (client: Client) => Promise<void>;
  closeHttp?: (server: Server, callback: (error?: Error) => void) => void;
  removeDirectory?: (directory: string) => void;
}

export function cleanupError(report: CleanupReport, ...primary: [] | [unknown]): AggregateError {
  const aggregate = new AggregateError([...primary, ...report.failures.map(item => item.error)],
    "Evaluation MCP fixture cleanup failed", primary.length ? { cause: primary[0] } : undefined);
  // Original errors remain in .errors; only this bounded projection is attached.
  return Object.assign(aggregate, {
    cleanupStages: report.failures.map(item => item.stage),
    removalDiagnostics: report.removalDiagnostics,
    diagnosticIssues: report.diagnosticIssues,
  });
}

function errorCode(error: unknown, failed?: () => void): string | undefined {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && ["EBUSY", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "EMFILE", "ENFILE", "EIO", "ENOTEMPTY"].includes(code) ? code : undefined;
  } catch { failed?.(); return undefined; }
}

function removalError(error: unknown): RemovalDiagnostics["error"] {
  const result: RemovalDiagnostics["error"] = { path: "<fixture>", issues: [] };
  result.code = errorCode(error, () => result.issues.push("code"));
  try {
    const syscall = (error as { syscall?: unknown } | null)?.syscall;
    if (typeof syscall === "string" && ["rm", "unlink", "rmdir", "scandir"].includes(syscall)) result.syscall = syscall;
  } catch { result.issues.push("syscall"); }
  return result;
}

function inventory(directory: string): Inventory {
  const result: Inventory = { exists: null, members: [], truncated: false, issues: [] };
  let stream: ReturnType<typeof opendirSync> | undefined;
  try {
    stream = opendirSync(directory);
    result.exists = true;
    for (let index = 0; index < 17; index++) {
      const entry = stream.readSync();
      if (!entry) break;
      if (index === 16) { result.truncated = true; break; }
      const label = /^evaluations\.db(?:-(?:wal|shm|journal))?$/.test(entry.name) ? entry.name : `member-${index + 1}`;
      try {
        const stat = lstatSync(path.join(directory, entry.name));
        result.members.push({ label, type: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other", size: stat.size });
      } catch (error) { result.issues.push({ operation: "stat", code: errorCode(error) }); }
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") result.exists = false;
    else result.issues.push({ operation: stream ? "read" : "open", code: errorCode(error) });
  } finally {
    try { stream?.closeSync(); }
    catch (error) { result.issues.push({ operation: "close", code: errorCode(error) }); }
  }
  return result;
}

export class EvaluationMcpFixture {
  directory: string | undefined;
  server: Server | undefined;
  client: Client | undefined;
  mcp: McpServerHandle | undefined;
  report: CleanupReport | undefined;
  private oldDb = { present: Object.hasOwn(process.env, "RUNPHANTOM_DB_PATH"), value: process.env.RUNPHANTOM_DB_PATH };
  private clientTransport: InMemoryTransport | undefined;
  private serverTransport: InMemoryTransport | undefined;
  private databaseOwned = false;
  private setupStarted = false;
  private cleanupPromise: Promise<CleanupReport> | undefined;
  constructor(private controls: FixtureControls = {}) {}

  async setup(): Promise<void> {
    if (this.setupStarted) throw new Error("Evaluation MCP fixture setup was already attempted");
    this.setupStarted = true;
    try {
      this.directory = mkdtempSync(path.join(tmpdir(), "rp-evaluation-mcp-"));
      closeDb();
      process.env.RUNPHANTOM_DB_PATH = path.join(this.directory, "evaluations.db");
      this.databaseOwned = true;
      ({ server: this.server } = await createServer(0));
      this.server.listen(0, "127.0.0.1");
      await once(this.server, "listening");
      getDrizzleDb();
      await this.controls.afterHttpReady?.(this);
      [this.clientTransport, this.serverTransport] = InMemoryTransport.createLinkedPair();
      this.mcp = await runMcpServer({ url: this.url, transport: this.serverTransport });
      this.client = new Client({ name: "evaluation-mcp-regression", version: "1.0.0" });
      await this.client.connect(this.clientTransport);
    } catch (primary) {
      const report = await this.cleanup();
      if (report.failures.length) throw cleanupError(report, primary);
      throw primary;
    }
  }

  get url(): string { return `http://127.0.0.1:${(this.server!.address() as { port: number }).port}`; }

  async restartHttp(): Promise<Server> {
    const previous = this.server;
    if (!this.setupStarted || this.cleanupPromise || !previous?.listening) throw new Error("Evaluation MCP fixture HTTP restart requires a live fixture before cleanup");
    if (!this.directory || process.env.RUNPHANTOM_DB_PATH !== path.join(this.directory, "evaluations.db")) throw new Error("Evaluation MCP fixture database profile changed before HTTP restart");
    const address = previous.address();
    if (!address || typeof address === "string") throw new Error("Evaluation MCP fixture HTTP restart requires a TCP listener");
    // The owned close drains services and releases the database lease before reopening.
    await new Promise<void>((resolve, reject) => previous.close(error => error ? reject(error) : resolve()));
    this.server = undefined;
    ({ server: this.server } = await createServer(address.port));
    this.server.listen(address.port, "127.0.0.1");
    await once(this.server, "listening");
    return this.server;
  }

  cleanup(): Promise<CleanupReport> {
    // Cache before entering a delegate: afterEach and setup's catch share one attempt.
    return this.cleanupPromise ??= Promise.resolve().then(() => this.performCleanup());
  }

  private async performCleanup(): Promise<CleanupReport> {
    const report: CleanupReport = { stages: [], failures: [] };
    this.report = report;
    const stage = async (name: FixtureStage, acquired: boolean, action: () => void | Promise<void>) => {
      const receipt: StageReceipt = { stage: name, acquired, attempted: acquired, succeeded: false, failed: false };
      report.stages.push(receipt);
      if (!acquired) return;
      try { await action(); receipt.succeeded = true; }
      catch (error) { receipt.failed = true; report.failures.push({ stage: name, error }); }
    };
    await stage("client-close", !!this.client, () => this.controls.closeClient ? this.controls.closeClient(this.client!) : this.client!.close());
    await stage("mcp-close", !!this.mcp, () => this.mcp!.close());
    // Either protocol owner closes the linked pair. Fallback owns one endpoint
    // only when partial acquisition returned neither normal protocol owner.
    await stage("transport-close", !!this.serverTransport && !this.client && !this.mcp, () => this.serverTransport!.close());
    await stage("http-close", !!this.server, () => new Promise<void>((resolve, reject) => {
      const callback = (error?: Error) => error ? reject(error) : resolve();
      if (this.controls.closeHttp) this.controls.closeHttp(this.server!, callback);
      else this.server!.close(callback);
    }));
    await stage("db-close", this.databaseOwned, () => closeDb());
    await stage("env-restore", true, () => {
      if (this.oldDb.present) process.env.RUNPHANTOM_DB_PATH = this.oldDb.value!;
      else delete process.env.RUNPHANTOM_DB_PATH;
    });
    await stage("directory-remove", !!this.directory, () => {
      const directory = this.directory!;
      const before = inventory(directory);
      try {
        if (this.controls.removeDirectory) this.controls.removeDirectory(directory);
        else rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        // Diagnostics are subordinate to the exact original removal failure.
        try {
          report.removalDiagnostics = {
            fixture: /^rp-evaluation-mcp-[A-Za-z0-9_-]{1,32}$/.test(path.basename(directory)) ? path.basename(directory) : "owned-evaluation-mcp",
            database: "evaluations.db", before, after: inventory(directory), stages: report.stages.map(item => ({ ...item })),
            error: removalError(error),
          };
        } catch { report.diagnosticIssues = ["removal-diagnostics"]; }
        throw error;
      }
    });
    // Include the terminal directory-stage result, not its in-progress receipt.
    if (report.removalDiagnostics) report.removalDiagnostics.stages = report.stages.map(item => ({ ...item }));
    return report;
  }
}
