import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { acquireClaudeTranscript, type TranscriptAcquisition } from "./claude";
import { inspectClaudeHookSettings, mergeClaudeSettings, readClaudeSettingsText, updateClaudeSettings } from "./install";
import { hookDigest, isHex, refuse } from "./protocol";
import { parseBoundedHookJson, type ClaudeHookInput } from "./shared";
import { CodingHookStore, validateInstallationBinding, type HookAdmission, type InstallationBinding } from "./store";

const CAPABILITY_VERSION = "runphantom.claude-capability/v1";
const sameFile = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
const owned = (stats: BigIntStats) => process.platform !== "win32" && typeof process.getuid === "function" && stats.uid === BigInt(process.getuid());
export const installationIdForSettings = (scope: "global" | "local", settingsPath: string): string => hookDigest(JSON.stringify(["runphantom.claude.installation/v1", scope, settingsPath])).slice(0, 32);

/** Private capability material is never placed in vendor settings or public diagnostic projections. */
export async function readClaudeCapability(file: string, installationId: string): Promise<string> {
  const parent = path.dirname(file), parentBefore = await lstat(parent, { bigint: true });
  if (!path.isAbsolute(file) || path.normalize(file) !== file || !parentBefore.isDirectory() || parentBefore.isSymbolicLink() || !owned(parentBefore) || (parentBefore.mode & 0o777n) !== 0o700n || await realpath(parent) !== parent) refuse("unauthorized", 401);
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || !owned(before) || (before.mode & 0o777n) !== 0o600n || before.size > 4096n) refuse("unauthorized", 401);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const initial = await handle.stat({ bigint: true }); if (!sameFile(initial, before) || !initial.isFile() || !owned(initial) || (initial.mode & 0o777n) !== 0o600n || initial.size > 4096n) refuse("unauthorized", 401);
    const bytes = Buffer.alloc(Number(initial.size)); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) refuse("unavailable", 503); offset += result.bytesRead; }
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (!sameFile(parentBefore, await lstat(parent, { bigint: true })) || await realpath(parent) !== parent || !sameFile(initial, current) || !sameFile(initial, after) || after.size !== initial.size || after.mtimeNs !== initial.mtimeNs || after.ctimeNs !== initial.ctimeNs) refuse("unavailable", 503);
    let raw: string; try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { refuse("corrupt", 503); }
    const parsed = parseBoundedHookJson(raw, 4096); if (parsed.status !== "accepted" || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) refuse("corrupt", 503);
    const value = parsed.value;
    if (Object.keys(value).sort().join(",") !== "installationId,token,version" || value.version !== CAPABILITY_VERSION || value.installationId !== installationId || !isHex(value.token, 64)) refuse("corrupt", 503);
    return value.token;
  } finally { await handle.close(); }
}

/** Even a valid local full capability cannot use an unregistered cwd or another project's source. */
export async function acquireRegisteredClaudeTranscript(hook: ClaudeHookInput, admission: HookAdmission, signal?: AbortSignal): Promise<TranscriptAcquisition> {
  const binding = admission.binding;
  if (hook.cwd !== binding.registeredWorkspace) return { status: "unavailable", reason: "path_not_authorized" };
  const reported = hook.event === "SubagentStop" ? hook.agentTranscriptPath : hook.transcriptPath;
  if (!reported) return { status: "unavailable", reason: "source_unavailable" };
  const candidate = reported.startsWith("~/") ? path.join(binding.homeDirectory, reported.slice(2)) : reported;
  const relative = path.relative(binding.projectDirectory, candidate);
  if (!path.isAbsolute(candidate) || !relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return { status: "unavailable", reason: "path_not_authorized" };
  return acquireClaudeTranscript(hook, { projectsRoot: binding.transcriptRoot, homeDirectory: binding.homeDirectory, cursor: admission.transcriptCursor, prefixBytes: admission.prefixBytes, expectedIncarnationKey: admission.incarnationKey, expectedPrefixSha256: admission.prefixSha256 }, signal);
}

/** Trusted local management only. Caller supplies explicit full consent; callback JSON never enters this API. */
export class ClaudeHookManagement {
  constructor(readonly store: CodingHookStore) {}
  private async directory(): Promise<string> {
    if (!path.isAbsolute(this.store.db.filename)) refuse("inactive", 503);
    const profile = await realpath(path.dirname(this.store.db.filename));
    let directory = profile;
    for (const component of ["coding-hooks", "claude"]) {
      directory = path.join(directory, component); await mkdir(directory, { mode: 0o700 }).catch(error => { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; });
      const stats = await lstat(directory, { bigint: true }); if (!stats.isDirectory() || stats.isSymbolicLink() || !owned(stats) || (stats.mode & 0o777n) !== 0o700n) refuse("unauthorized", 401);
    }
    return directory;
  }
  private async binding(value: InstallationBinding): Promise<InstallationBinding> {
    value = validateInstallationBinding(value);
    if (value.installationId !== installationIdForSettings(value.scope, value.settingsPath)) refuse("malformed", 400);
    for (const directory of [value.registeredWorkspace, value.transcriptRoot, value.projectDirectory, value.homeDirectory]) {
      const stats = await lstat(directory); if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(directory) !== directory) refuse("unauthorized", 401);
    }
    if (value.scope === "local" && value.settingsPath !== path.join(value.registeredWorkspace, ".claude/settings.local.json")) refuse("unauthorized", 401);
    return value;
  }
  private async lease<T>(directory: string, id: string, work: () => Promise<T>): Promise<T> {
    const file = path.join(directory, id + ".lock"); let handle: FileHandle;
    try { handle = await open(file, "wx", 0o600); } catch { refuse("busy", 409); }
    const stats = await handle.stat({ bigint: true });
    try { return await work(); } finally { await handle.close(); const current = await lstat(file, { bigint: true }).catch(() => null); if (current && sameFile(stats, current)) await unlink(file); }
  }
  private async writeCapability(directory: string, id: string, token: string): Promise<void> {
    const file = path.join(directory, id + ".json"), temporary = path.join(directory, "." + randomBytes(12).toString("hex") + ".tmp"), before = await lstat(directory, { bigint: true });
    const handle = await open(temporary, "wx", 0o600); let temporaryStats: BigIntStats;
    try { temporaryStats = await handle.stat({ bigint: true }); await handle.writeFile(JSON.stringify({ version: CAPABILITY_VERSION, installationId: id, token }) + "\n"); await handle.sync(); } finally { await handle.close(); }
    try {
      const current = await lstat(directory, { bigint: true }); if (!sameFile(before, current) || current.isSymbolicLink()) refuse("unavailable", 503);
      const existing = await lstat(file, { bigint: true }).catch(() => null); if (existing && (!existing.isFile() || existing.isSymbolicLink() || !owned(existing) || (existing.mode & 0o777n) !== 0o600n)) refuse("unauthorized", 401);
      await rename(temporary, file);
    } finally { const current = await lstat(temporary, { bigint: true }).catch(() => null); if (current && sameFile(current, temporaryStats!)) await unlink(temporary); }
  }
  async install(input: InstallationBinding, options: { fullConsent?: boolean } = {}): Promise<{ status: "configured"; installationId: string; policy: "active"; captureMode: "metadata" | "full"; captureCoverage: "registered_workspace_only"; transport: "unavailable"; captureVerified: false; unchanged: boolean }> {
    const binding = await this.binding(input);
    if (binding.captureMode === "full" && options.fullConsent !== true) refuse("unauthorized", 401);
    const directory = await this.directory();
    return this.lease(directory, binding.installationId, async () => {
      try {
        const before = this.store.readInstallation(binding.installationId), current = await readClaudeSettingsText(binding.settingsPath);
        let staged = current;
        if (before && before.binding.executable !== binding.executable) {
          const removed = mergeClaudeSettings(staged, "uninstall", { executable: before.binding.executable, installationId: binding.installationId }); if (removed.status !== "accepted") refuse("unavailable", 503); staged = removed.text;
        }
        const merged = mergeClaudeSettings(staged, "install", { executable: binding.executable, installationId: binding.installationId }); if (merged.status !== "accepted" || merged.text === null) refuse("unavailable", 503);
        const configSha256 = hookDigest(merged.text), capabilityPath = path.join(directory, binding.installationId + ".json");
        let token = randomBytes(32).toString("hex");
        if (before?.row.state === "active" && before.row.data === JSON.stringify(binding) && before.row.config_sha256 === configSha256) {
          const priorToken = await readClaudeCapability(capabilityPath, binding.installationId); if (hookDigest(priorToken) !== before.row.token_sha256) refuse("unauthorized", 401); token = priorToken;
        }
        const receipt = this.store.prepareInstallation(binding, token, configSha256);
        if (!receipt.unchanged) await this.writeCapability(directory, binding.installationId, token);
        if (before && before.binding.executable !== binding.executable) { const removed = await updateClaudeSettings(binding.settingsPath, "uninstall", { executable: before.binding.executable, installationId: binding.installationId }); if (removed.status !== "accepted") refuse("unavailable", 503); }
        const installed = await updateClaudeSettings(binding.settingsPath, "install", { executable: binding.executable, installationId: binding.installationId });
        if (installed.status !== "accepted" || installed.text === null || hookDigest(installed.text) !== configSha256 || hookDigest(await readClaudeSettingsText(binding.settingsPath) ?? "") !== configSha256 || await readClaudeCapability(capabilityPath, binding.installationId) !== token) refuse("unavailable", 503);
        this.store.commitInstallation(binding.installationId, receipt.installationGeneration, token, configSha256, receipt.ownerGeneration);
        return { status: "configured", installationId: binding.installationId, policy: "active", captureMode: binding.captureMode, captureCoverage: "registered_workspace_only", transport: "unavailable", captureVerified: false, unchanged: receipt.unchanged };
      } catch (error) { this.store.disableInstallation(binding.installationId); throw error; }
    });
  }
  async uninstall(id: string): Promise<{ status: "removed" | "configuration_preserved"; capturePolicy: "disabled"; captureVerified: false }> {
    if (!isHex(id, 32)) refuse("malformed", 400); const directory = await this.directory();
    return this.lease(directory, id, async () => {
      const before = this.store.readInstallation(id); if (!before) return { status: "configuration_preserved", capturePolicy: "disabled", captureVerified: false };
      this.store.disableInstallation(id);
      const removed = await updateClaudeSettings(before.binding.settingsPath, "uninstall", { installationId: id, executable: before.binding.executable });
      const file = path.join(directory, id + ".json");
      try { const token = await readClaudeCapability(file, id); if (hookDigest(token) === before.row.token_sha256) { const stats = await lstat(file, { bigint: true }); const current = await lstat(file, { bigint: true }); if (sameFile(stats, current)) await unlink(file); } } catch { /* Uncertain private-file ownership is preserved after authority revocation. */ }
      return { status: removed.status === "accepted" ? "removed" : "configuration_preserved", capturePolicy: "disabled", captureVerified: false };
    });
  }
  async doctor(id: string) {
    const before = this.store.readInstallation(id); if (!before) return { configuration: "missing", capturePolicy: "unavailable", transport: "unavailable", captureVerified: false, captureCoverage: "registered_workspace_only" } as const;
    const config = await inspectClaudeHookSettings(before.binding.settingsPath, { installationId: id, executable: before.binding.executable });
    let capability: "available" | "unavailable" = "unavailable";
    try { const file = path.join(await realpath(path.dirname(this.store.db.filename)), "coding-hooks/claude", id + ".json"); if (hookDigest(await readClaudeCapability(file, id)) === before.row.token_sha256) capability = "available"; } catch { /* Diagnostic only; no private token is exposed. */ }
    return { ...config, capability, capturePolicy: before.row.state, captureMode: before.row.capture_mode, settingsScope: before.binding.scope, captureCoverage: "registered_workspace_only" as const, transport: "unavailable" as const, captureVerified: false as const };
  }
}
