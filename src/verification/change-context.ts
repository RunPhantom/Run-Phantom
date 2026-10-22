import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { VerificationHttpError } from "./bridge";
import { isSensitiveKey, scrubKnownSecrets } from "./redaction";
import { buildFailureHandoff } from "./report-context";
import type { ChangeWorkspaceOffer, VerificationChangeContext, VerificationReport } from "./protocol";

export const CHANGE_CONTEXT_LIMITS = { deadlineMs: 1000, activeReads: 2, commands: 5, stdoutBytes: 65536,
  stderrBytes: 4096, rows: 128, untrackedRows: 64, pathBytes: 512, inventoryRows: 2048, hints: 16,
  responseBytes: 24576, leaseMs: 60000, leases: 32, indexBytes: 4194304, metadataBytes: 65536, packEntries: 2048 } as const;
export interface ChangeWorkspace { cwd: string; revision: string }
export interface ChangeAuthority { id: string; role: "owner" | "reader"; generation: number }
export interface ChangeContextOptions {
  workspace(): ChangeWorkspace | null;
  authority(): ChangeAuthority | null;
  report(id: string): VerificationReport | undefined;
  /** Host configuration only; native tests use an owned wrapper around the real git executable. */
  gitExecutable?: string;
}
interface Lease { view: ChangeWorkspaceOffer; workspace: ChangeWorkspace; directory: string; owner: ChangeAuthority }
let activeReads = 0;
class MetadataUnavailable extends Error { constructor(readonly reason: string) { super(reason); } }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const invalidText = (value: string) => [...value].some(character => {
  const code = character.codePointAt(0)!;
  return code < 32 || code >= 127 && code <= 159 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069 || code >= 0xd800 && code <= 0xdfff;
});
function safePath(value: string): boolean {
  // Inspect the complete value before any clipping. No file contents enter this predicate.
  return !invalidText(value) && !path.isAbsolute(value) && !/[\\:]/.test(value)
    && !value.split("/").some(part => !part || part === "." || part === ".." || isSensitiveKey(part)
      || /^\.env(?:\.|$)|^(?:id_rsa|id_ed25519)(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(part))
    && scrubKnownSecrets(value) === value && Buffer.byteLength(value) <= CHANGE_CONTEXT_LIMITS.pathBytes;
}
function directoryIdentity(cwd: string): string {
  const canonical = fs.realpathSync(cwd); const stat = fs.statSync(canonical, { bigint: true });
  if (canonical !== cwd || !stat.isDirectory()) throw new VerificationHttpError(409, "Selected workspace changed");
  return `${canonical}\0${stat.dev}:${stat.ino}`;
}

function metadataFile(name: string, maximum: number, optional = false): Buffer | null {
  let descriptor: number | undefined;
  try {
    const named = fs.lstatSync(name, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.size > BigInt(maximum)) throw new MetadataUnavailable("git-metadata-unavailable");
    descriptor = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    const identity = (value: typeof before) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    if (identity(named) !== identity(before)) throw new MetadataUnavailable("git-metadata-changed");
    const buffer = Buffer.alloc(Number(before.size) + 1); const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length !== Number(before.size) || identity(before) !== identity(fs.fstatSync(descriptor, { bigint: true }))
      || identity(before) !== identity(fs.lstatSync(name, { bigint: true }))) throw new MetadataUnavailable("git-metadata-changed");
    return buffer.subarray(0, length);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof MetadataUnavailable) throw error;
    throw new MetadataUnavailable("git-metadata-unavailable");
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Strict finite flat request. Duplicate/extra keys cannot survive an upstream JSON parser. */
export function verifyChangeContextJson(raw: Uint8Array): void {
  if (raw.byteLength > 256) throw new VerificationHttpError(413, "Change context request exceeds its byte bound");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { throw new VerificationHttpError(400, "Invalid change context encoding"); }
  if (!/^\s*\{\s*"workspaceId"\s*:\s*"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"\s*\}\s*$/.test(text)) throw new VerificationHttpError(400, "Change context requires one workspaceId field");
  try { JSON.parse(text); } catch { throw new VerificationHttpError(400, "Invalid change context JSON"); }
}

/** Private ephemeral selections and actual read processes; saved reports are never rewritten. */
export class ChangeContextReader {
  private readonly leases = new Map<string, Lease>();
  private readonly aborts = new Set<AbortController>();
  private closed = false;
  constructor(private readonly options: ChangeContextOptions) {}
  private owner(): ChangeAuthority {
    const owner = this.options.authority();
    if (this.closed || !owner || owner.role !== "owner" || typeof owner.id !== "string" || !owner.id || owner.id.length > 128
      || !Number.isSafeInteger(owner.generation) || owner.generation < 0) throw new VerificationHttpError(403, "Current local workspace owner required");
    return { ...owner };
  }
  offer(): ChangeWorkspaceOffer {
    const owner = this.owner(); const selected = this.options.workspace();
    if (!selected || typeof selected.cwd !== "string" || typeof selected.revision !== "string" || !selected.revision || selected.revision.length > 256)
      throw new VerificationHttpError(409, "Select an active workspace explicitly before reviewing changes");
    const directory = directoryIdentity(selected.cwd);
    for (const [id, lease] of this.leases) if (lease.view.expiresAt <= Date.now()) this.leases.delete(id);
    if (this.leases.size >= CHANGE_CONTEXT_LIMITS.leases) throw new VerificationHttpError(409, "Workspace review selection limit reached");
    const basename = path.basename(selected.cwd);
    const view = { workspaceId: randomUUID(), label: safePath(basename) ? basename : "Selected workspace", expiresAt: Date.now() + CHANGE_CONTEXT_LIMITS.leaseMs };
    this.leases.set(view.workspaceId, { view, workspace: { ...selected }, directory, owner });
    return { ...view };
  }
  cancel(id: string): void { this.leases.delete(id); }
  close(): void { this.closed = true; this.leases.clear(); for (const controller of this.aborts) controller.abort(); }
  async capture(workspaceId: string, reportId: string, externalSignal?: AbortSignal): Promise<VerificationChangeContext> {
    const lease = this.leases.get(workspaceId);
    if (!lease) throw new VerificationHttpError(409, "Workspace selection expired or changed");
    const original = this.options.report(reportId);
    if (!original) throw new VerificationHttpError(404, "Retained verification report unavailable");
    const originalBytes = JSON.stringify(original);
    const handoff = buildFailureHandoff(original);
    const controller = new AbortController(); const signal = controller.signal;
    const abort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    const checkpoint = () => {
      const owner = this.owner(); const workspace = this.options.workspace();
      if (signal.aborted || this.leases.get(workspaceId) !== lease || lease.view.expiresAt <= Date.now()
        || owner.id !== lease.owner.id || owner.generation !== lease.owner.generation || !workspace
        || workspace.cwd !== lease.workspace.cwd || workspace.revision !== lease.workspace.revision
        || directoryIdentity(workspace.cwd) !== lease.directory || JSON.stringify(this.options.report(reportId)) !== originalBytes)
        throw new VerificationHttpError(409, "Workspace, permission or retained report changed during review");
    };
    checkpoint();
    if (activeReads >= CHANGE_CONTEXT_LIMITS.activeReads) throw new VerificationHttpError(409, "Workspace change reader is busy; no read was queued");
    activeReads++; this.aborts.add(controller);
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const deadline = performance.now() + CHANGE_CONTEXT_LIMITS.deadlineMs;
    let commands = 0;
    let privateDirectory: string | undefined;
    let gitDirectory: string | undefined;
    const metadataIdentities = new Map<string, string>();
    const metadataCheckpoint = () => {
      checkpoint();
      if (performance.now() >= deadline) throw new MetadataUnavailable("deadline");
      for (const [name, identity] of metadataIdentities) if (directoryIdentity(name) !== identity) throw new MetadataUnavailable("git-metadata-changed");
    };
    const run = async (args: string[]) => {
      metadataCheckpoint();
      if (++commands > CHANGE_CONTEXT_LIMITS.commands || performance.now() >= deadline) throw new MetadataUnavailable("deadline");
      const result = await new Promise<{ stdout: Buffer; stderr: Buffer; code: number | null }>((resolve, reject) => {
        const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
        const child = spawn(this.options.gitExecutable ?? "git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", `core.hooksPath=${nullFile}`,
          "-c", `core.attributesFile=${nullFile}`, "-c", "protocol.allow=never", "-c", "core.quotePath=false", ...args], { cwd: lease.workspace.cwd, detached: process.platform !== "win32",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullFile,
            GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
            ...(gitDirectory ? { GIT_DIR: gitDirectory, GIT_WORK_TREE: lease.workspace.cwd } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
        const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outBytes = 0; let errBytes = 0; let failure: Error | undefined;
        const stop = (error: Error) => {
          failure ??= error;
          if (child.pid) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
        };
        const onAbort = () => stop(new VerificationHttpError(409, "Workspace review cancelled"));
        const timer = setTimeout(() => stop(new MetadataUnavailable("deadline")), Math.max(1, deadline - performance.now()));
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > CHANGE_CONTEXT_LIMITS.stdoutBytes) stop(new MetadataUnavailable("git-output-limit")); else stdout.push(chunk); });
        child.stderr.on("data", (chunk: Buffer) => { errBytes += chunk.length; if (errBytes > CHANGE_CONTEXT_LIMITS.stderrBytes) stop(new MetadataUnavailable("git-error-limit")); else stderr.push(chunk); });
        child.on("error", () => { failure ??= new MetadataUnavailable("git-unavailable"); });
        child.on("close", code => {
          // close follows stream drainage/reaping; the global slot is retained until this point.
          clearTimeout(timer); signal.removeEventListener("abort", onAbort);
          if (failure) reject(failure); else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
        });
        if (signal.aborted) onAbort();
      });
      metadataCheckpoint();
      return result;
    };
    const context: VerificationChangeContext = { version: 1, observedAt: Date.now(), head: null, testedRevision: null, fingerprint: null,
      fingerprintCoverage: "metadata-only", complete: true, reasons: [], withheldPaths: 0, omittedRows: 0, changes: [], relatedTests: [],
      suggestions: [{ kind: "happy-path", advisory: true, text: "Explicitly recheck the retained expectation in the affected user flow." },
        { kind: "persistence", advisory: true, text: "Check the declared outcome again after reload where persistence is expected." },
        { kind: "negative-path", advisory: true, text: "Check rejection, unavailable evidence and cancellation paths without creating real user data." }], handoff };
    const reason = (value: string) => { context.complete = false; if (!context.reasons.includes(value)) context.reasons.push(value); };
    const decode = (buffer: Buffer) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { throw new MetadataUnavailable("invalid-utf8"); } };
    const retainPath = (value: string) => { if (safePath(value)) return true; context.withheldPaths++; reason("path-unavailable"); return false; };
    try {
      // rev-parse reads metadata only. Subsequent worktree operations use a trusted private config/index.
      const root = await run(["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
      if (root.code !== 0) throw new MetadataUnavailable(decode(root.stderr).startsWith("fatal: not a git repository") ? "not-git" : "git-read-failed");
      const roots = decode(root.stdout).trimEnd().split("\n");
      if (roots.length !== 3 || roots.some(name => !path.isAbsolute(name) || invalidText(name))) throw new MetadataUnavailable("git-metadata-unavailable");
      if (fs.realpathSync(roots[0]) !== lease.workspace.cwd) throw new MetadataUnavailable("workspace-is-not-git-root");
      const originalGit = fs.realpathSync(roots[1]); const commonGit = fs.realpathSync(roots[2]);
      for (const name of new Set([originalGit, commonGit])) metadataIdentities.set(name, directoryIdentity(name));
      const configuration = decode(metadataFile(path.join(commonGit, "config"), CHANGE_CONTEXT_LIMITS.metadataBytes)!);
      // Config is inspected solely to refuse unsupported storage; it is never copied or evaluated by worktree reads.
      const extensions = configuration.match(/\[extensions\]([^[]*)/ig) ?? [];
      if (extensions.some(section => section.split("\n").slice(1).some(line => line.trim() && !/^(?:#|;|objectformat\s*=\s*sha(?:1|256)\s*$)/i.test(line.trim())))
        || /\bpromisor\s*=\s*(?:true|yes|1)\b/i.test(configuration)) throw new MetadataUnavailable("unsupported-git-storage");
      const objectDirectory = fs.realpathSync(path.join(commonGit, "objects"));
      metadataIdentities.set(objectDirectory, directoryIdentity(objectDirectory));
      if (fs.existsSync(path.join(objectDirectory, "info", "alternates")) || fs.existsSync(path.join(objectDirectory, "info", "http-alternates"))) throw new MetadataUnavailable("unsupported-git-storage");
      const packDirectory = path.join(objectDirectory, "pack");
      if (fs.existsSync(packDirectory)) {
        const directory = fs.opendirSync(packDirectory); let count = 0;
        try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          metadataCheckpoint(); if (++count > CHANGE_CONTEXT_LIMITS.packEntries || entry.name.endsWith(".promisor") || entry.isSymbolicLink()) throw new MetadataUnavailable("unsupported-git-storage");
        } } finally { directory.closeSync(); }
      }
      metadataCheckpoint(); privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "runphantom-git-view-")); gitDirectory = privateDirectory;
      const sha256 = /objectformat\s*=\s*sha256\s*$/im.test(configuration);
      fs.writeFileSync(path.join(privateDirectory, "config"), `[core]\n repositoryformatversion = ${sha256 ? 1 : 0}\n bare = false\n filemode = false\n symlinks = true\n${sha256 ? "[extensions]\n objectformat = sha256\n" : ""}`, { mode: 0o600 });
      fs.writeFileSync(path.join(privateDirectory, "HEAD"), metadataFile(path.join(originalGit, "HEAD"), CHANGE_CONTEXT_LIMITS.metadataBytes)!);
      const index = metadataFile(path.join(originalGit, "index"), CHANGE_CONTEXT_LIMITS.indexBytes, true);
      if (index) {
        const privateIndex = path.join(privateDirectory, "index"); fs.writeFileSync(privateIndex, index);
        // Copy time must not make original racy stat entries look trustworthy after a same-size rewrite.
        // Git treats timestamp zero as uninitialized; a nonzero old timestamp forces racy-entry reads.
        fs.utimesSync(privateIndex, 1, 1);
      }
      const packedRefs = metadataFile(path.join(commonGit, "packed-refs"), CHANGE_CONTEXT_LIMITS.metadataBytes, true);
      if (packedRefs) fs.writeFileSync(path.join(privateDirectory, "packed-refs"), packedRefs);
      fs.symlinkSync(objectDirectory, path.join(privateDirectory, "objects"), "dir");
      const refs = fs.realpathSync(path.join(commonGit, "refs")); metadataIdentities.set(refs, directoryIdentity(refs));
      fs.symlinkSync(refs, path.join(privateDirectory, "refs"), "dir");
      metadataCheckpoint();
      const revision = await run(["rev-parse", "--verify", "HEAD"]);
      if (revision.code === 0) { const value = decode(revision.stdout).trim(); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new MetadataUnavailable("invalid-head"); context.head = value; }
      else reason("unborn-head");
      const status = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
      if (status.code !== 0) throw new MetadataUnavailable("git-read-failed");
      const rows = decode(status.stdout).split("\0"); if (rows.pop() !== "") throw new MetadataUnavailable("invalid-git-records");
      let untracked = 0; let statusRows = 0;
      for (let at = 0; at < rows.length; at++) {
        if (++statusRows > CHANGE_CONTEXT_LIMITS.rows) { reason("row-limit"); context.omittedRows++; break; }
        const row = rows[at]; if (!/^[ AMDRCU?!]{2} /.test(row)) throw new MetadataUnavailable("invalid-git-records");
        const current = row.slice(3); const previous = /[RC]/.test(row.slice(0, 2)) ? rows[++at] : undefined;
        if (previous === undefined && /[RC]/.test(row.slice(0, 2))) throw new MetadataUnavailable("invalid-git-records");
        if (!retainPath(current) || previous !== undefined && !retainPath(previous)) continue;
        const change: VerificationChangeContext["changes"][number] = { path: current, ...(previous === undefined ? {} : { previousPath: previous }), index: row[0], worktree: row[1], binary: null, added: null, deleted: null, content: "unavailable" };
        if (row.startsWith("??")) {
          reason("untracked-content-unavailable");
          if (++untracked <= CHANGE_CONTEXT_LIMITS.untrackedRows) {
            try {
              const parent = fs.realpathSync(path.dirname(path.join(lease.workspace.cwd, current)));
              if (parent !== lease.workspace.cwd && !parent.startsWith(lease.workspace.cwd + path.sep)) throw new Error("outside selected workspace");
              const stat = fs.lstatSync(path.join(parent, path.basename(current)));
              if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || !Number.isFinite(stat.mtimeMs)) throw new Error("metadata unavailable");
              change.bytes = stat.size; change.modifiedAt = Math.trunc(stat.mtimeMs);
            } catch { reason("untracked-metadata-unavailable"); }
          } else reason("untracked-metadata-limit");
        }
        if (row.slice(0, 2).includes("U")) reason("merge-conflict");
        context.changes.push(change);
      }
      const stats = await run(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--find-renames", "--ignore-submodules=all", ...(context.head ? ["HEAD"] : ["--cached"]), "--"]);
      if (stats.code !== 0) throw new MetadataUnavailable("git-read-failed");
      const records = decode(stats.stdout).split("\0"); if (records.pop() !== "") throw new MetadataUnavailable("invalid-git-records");
      let statRows = 0;
      for (let at = 0; at < records.length; at++) {
        if (++statRows > CHANGE_CONTEXT_LIMITS.rows) { reason("row-limit"); break; }
        const record = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(records[at]); if (!record) throw new MetadataUnavailable("invalid-git-records");
        let name = record[3];
        if (!name) { const previous = records[++at]; name = records[++at]; if (previous === undefined || name === undefined) throw new MetadataUnavailable("invalid-git-records"); if (!retainPath(previous)) continue; }
        if (!retainPath(name)) continue;
        const change = context.changes.find(row => row.path === name); if (!change) continue;
        const added = record[1] === "-" ? null : Number(record[1]); const deleted = record[2] === "-" ? null : Number(record[2]);
        if (added !== null && !Number.isSafeInteger(added) || deleted !== null && !Number.isSafeInteger(deleted)) throw new MetadataUnavailable("invalid-git-count");
        change.binary = added === null || deleted === null; change.added = added; change.deleted = deleted;
      }
      const files = await run(["ls-files", "-z"]); if (files.code !== 0) throw new MetadataUnavailable("git-read-failed");
      const inventory = decode(files.stdout).split("\0"); if (inventory.pop() !== "") throw new MetadataUnavailable("invalid-git-records");
      if (inventory.length > CHANGE_CONTEXT_LIMITS.inventoryRows) reason("test-inventory-limit");
      const stems = context.changes.flatMap(row => [row.path, row.previousPath].filter((name): name is string => !!name)).map(name => path.basename(name).replace(/\.[^.]+$/, "").toLowerCase());
      for (const name of inventory.slice(0, CHANGE_CONTEXT_LIMITS.inventoryRows)) {
        if (!retainPath(name) || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) continue;
        const stem = path.basename(name).replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, "").toLowerCase();
        if (stems.includes(stem)) {
          if (context.relatedTests.length >= CHANGE_CONTEXT_LIMITS.hints) { reason("related-test-limit"); break; }
          context.relatedTests.push({ path: name, reason: "filename", advisory: true });
        }
      }
      context.fingerprint = hash(JSON.stringify({ head: context.head, changes: context.changes }));
    } catch (error) {
      checkpoint();
      if (!(error instanceof MetadataUnavailable)) throw error;
      reason(error.reason); context.changes = []; context.relatedTests = []; context.fingerprint = null;
    } finally {
      // Every run has reached child close before this cleanup, including abort/deadline failures.
      if (privateDirectory) fs.rmSync(privateDirectory, { recursive: true, force: true });
      activeReads--; this.aborts.delete(controller); externalSignal?.removeEventListener("abort", abort);
    }
    checkpoint();
    while (bytes(context) > CHANGE_CONTEXT_LIMITS.responseBytes && (context.changes.length || context.relatedTests.length)) {
      reason("response-limit");
      if (context.changes.length) { context.changes.pop(); context.omittedRows++; } else context.relatedTests.pop();
    }
    if (bytes(context) > CHANGE_CONTEXT_LIMITS.responseBytes) throw new VerificationHttpError(409, "Change context exceeds its byte bound");
    this.leases.delete(workspaceId);
    return context;
  }
}
