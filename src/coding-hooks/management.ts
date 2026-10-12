import { randomBytes } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { inspectClaudeHookSettings, mergeClaudeSettings, readClaudeSettingsText, updateClaudeSettings } from "./install";
import { hookDigest, isHex, refuse } from "./protocol";
import { encodeInstallationCatalog, registrationForBinding, validateCatalog, type SourceRegistration } from "./catalog";
import { CodingHookStore, validateInstallationBinding, type InstallationBinding } from "./store";

import { CAPABILITY_VERSION, capabilityOwnerKey, encodeClaudeCapability, readClaudeCapabilityDescriptor, validClaudeCapabilityOrigin, type ClaudeCapabilityDescriptor } from "./capability";
const sameFile = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
const owned = (stats: BigIntStats) => process.platform !== "win32" && typeof process.getuid === "function" && stats.uid === BigInt(process.getuid());
export const installationIdForSettings = (scope: "global" | "local", settingsPath: string): string => hookDigest(JSON.stringify(["runphantom.claude.installation/v1", scope, settingsPath])).slice(0, 32);

/** Compatibility token accessor for trusted management; disabled files carry no usable credential. */
export async function readClaudeCapability(file: string, installationId: string): Promise<string> {
  const descriptor = await readClaudeCapabilityDescriptor(file, installationId);
  if (descriptor.state !== "active" || descriptor.token === null) refuse("inactive", 503); return descriptor.token;
}

export { acquireRegisteredClaudeTranscript } from "./acquisition";

/** Trusted local management only. Caller supplies explicit full consent; callback JSON never enters this API. */
export class ClaudeHookManagement {
  constructor(readonly store: CodingHookStore, private readonly transportOrigin: string | null = null, private readonly transportActive = false) { if (transportOrigin !== null && !validClaudeCapabilityOrigin(transportOrigin)) refuse("malformed", 400); }
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
  private async writeCapability(directory: string, descriptor: ClaudeCapabilityDescriptor): Promise<void> {
    const id = descriptor.installationId;
    const file = path.join(directory, id + ".json"), temporary = path.join(directory, "." + randomBytes(12).toString("hex") + ".tmp"), before = await lstat(directory, { bigint: true });
    const handle = await open(temporary, "wx", 0o600); let temporaryStats: BigIntStats;
    try {
      try { temporaryStats = await handle.stat({ bigint: true }); await handle.writeFile(encodeClaudeCapability(descriptor)); await handle.sync(); } finally { await handle.close(); }
      const current = await lstat(directory, { bigint: true }); if (!sameFile(before, current) || current.isSymbolicLink()) refuse("unavailable", 503);
      const existing = await lstat(file, { bigint: true }).catch(() => null); if (existing && (!existing.isFile() || existing.isSymbolicLink() || !owned(existing) || (existing.mode & 0o777n) !== 0o600n)) refuse("unauthorized", 401);
      await rename(temporary, file);
    } finally { const current = await lstat(temporary, { bigint: true }).catch(() => null); if (current && sameFile(current, temporaryStats!)) await unlink(temporary); }
  }
  async install(input: InstallationBinding, options: { fullConsent?: boolean; registrations?: SourceRegistration[]; expectedInstallationGeneration?: string } = {}): Promise<{ status: "configured"; installationId: string; policy: "active" | "disabled"; captureMode: "metadata" | "full"; captureCoverage: "inactive" | "registered_workspace_only" | "registered_workspaces"; registrationCount: number; transport: "unavailable" | "available"; captureVerified: false; unchanged: boolean }> {
    const binding = await this.binding(input), registrations = validateCatalog(binding, options.registrations);
    for (const registration of registrations) for (const directory of [registration.registeredWorkspace, registration.transcriptRoot, registration.projectDirectory, registration.homeDirectory]) { const stats = await lstat(directory); if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(directory) !== directory) refuse("unknown_scope", 409); }
    const catalogData = encodeInstallationCatalog(binding, registrations);
    if (binding.captureMode === "full" && options.fullConsent !== true) refuse("unauthorized", 401);
    const directory = await this.directory(), capabilityPath = path.join(directory, binding.installationId + ".json"), ownerKey = capabilityOwnerKey(await realpath(this.store.db.filename));
    const authority = { executable: binding.executable, installationId: binding.installationId, capabilityFile: capabilityPath };
    return this.lease(directory, binding.installationId, async () => {
      const before = this.store.readInstallation(binding.installationId);
      if (options.expectedInstallationGeneration !== undefined && before?.row.generation !== options.expectedInstallationGeneration) refuse("stale");
      try {
        const current = await readClaudeSettingsText(binding.settingsPath);
        let staged = current;
        if (before && before.binding.executable !== binding.executable) {
          const removed = mergeClaudeSettings(staged, "uninstall", { ...authority, executable: before.binding.executable }); if (removed.status !== "accepted") refuse("unavailable", 503); staged = removed.text;
        }
        const merged = mergeClaudeSettings(staged, "install", authority); if (merged.status !== "accepted" || merged.text === null) refuse("unavailable", 503);
        const configSha256 = hookDigest(merged.text);
        const existing = await lstat(capabilityPath, { bigint: true }).catch(() => null);
        const prior = existing ? await readClaudeCapabilityDescriptor(capabilityPath, binding.installationId, ownerKey) : null;
        if (this.transportOrigin === null || !this.store.isOwnerActive()) {
          this.store.disableInstallation(binding.installationId);
          const disabled: ClaudeCapabilityDescriptor = { version: CAPABILITY_VERSION, installationId: binding.installationId, capabilityFile: capabilityPath, ownerKey, state: "disabled", token: null, ownerGeneration: null, installationGeneration: null, origin: null };
          await this.writeCapability(directory, disabled);
          const installed = await updateClaudeSettings(binding.settingsPath, "install", authority);
          if (installed.status !== "accepted" || installed.text === null || hookDigest(installed.text) !== configSha256) refuse("unavailable", 503);
          return { status: "configured", installationId: binding.installationId, policy: "disabled", captureMode: "metadata", captureCoverage: "inactive", registrationCount: 0, transport: "unavailable", captureVerified: false, unchanged: !installed.changed };
        }
        let token = randomBytes(32).toString("hex");
        if (before?.row.state === "active" && before.row.data === catalogData && before.row.config_sha256 === configSha256) {
          if (prior?.state !== "active" || prior.token === null || hookDigest(prior.token) !== before.row.token_sha256 || prior.installationGeneration !== before.row.generation) refuse("unauthorized", 401); token = prior.token;
        }
        const receipt = this.store.prepareInstallation(binding, token, configSha256, registrations);
        const descriptor: ClaudeCapabilityDescriptor = { version: CAPABILITY_VERSION, installationId: binding.installationId, capabilityFile: capabilityPath, ownerKey, state: "active", token, ownerGeneration: receipt.ownerGeneration, installationGeneration: receipt.installationGeneration, origin: this.transportOrigin };
        if (!receipt.unchanged || prior?.ownerGeneration !== receipt.ownerGeneration || prior.origin !== this.transportOrigin) await this.writeCapability(directory, descriptor);
        if (before && before.binding.executable !== binding.executable) { const removed = await updateClaudeSettings(binding.settingsPath, "uninstall", { ...authority, executable: before.binding.executable }); if (removed.status !== "accepted") refuse("unavailable", 503); }
        const installed = await updateClaudeSettings(binding.settingsPath, "install", authority);
        if (installed.status !== "accepted" || installed.text === null || hookDigest(installed.text) !== configSha256 || hookDigest(await readClaudeSettingsText(binding.settingsPath) ?? "") !== configSha256 || JSON.stringify(await readClaudeCapabilityDescriptor(capabilityPath, binding.installationId, ownerKey)) !== JSON.stringify(descriptor)) refuse("unavailable", 503);
        this.store.commitInstallation(binding.installationId, receipt.installationGeneration, token, configSha256, receipt.ownerGeneration);
        return { status: "configured", installationId: binding.installationId, policy: "active", captureMode: binding.captureMode, captureCoverage: binding.scope === "global" && registrations.length > 1 ? "registered_workspaces" : "registered_workspace_only", registrationCount: registrations.length, transport: this.transportActive ? "available" : "unavailable", captureVerified: false, unchanged: receipt.unchanged };
      } catch (error) { this.store.disableInstallation(binding.installationId); throw error; }
    });
  }
  async unregister(id: string, registrationId: string) {
    if (!isHex(id, 32) || !isHex(registrationId, 64)) refuse("malformed", 400);
    const before = this.store.readInstallation(id); if (!before || before.binding.scope !== "global") refuse("unknown_scope", 409);
    const registrations = before.registrations.filter(value => value.registrationId !== registrationId);
    if (registrations.length === before.registrations.length) return { status: "unchanged" as const, captureVerified: false as const };
    if (!registrations.length) return this.uninstall(id);
    const primary = registrations.find(value => value.registrationId === registrationForBinding(before.binding).registrationId) ?? registrations[0];
    return this.install({ ...before.binding, registeredWorkspace: primary.registeredWorkspace, transcriptRoot: primary.transcriptRoot, projectDirectory: primary.projectDirectory, homeDirectory: primary.homeDirectory }, { registrations, expectedInstallationGeneration: before.row.generation });
  }
  async uninstall(id: string, input?: InstallationBinding): Promise<{ status: "removed" | "configuration_preserved"; capturePolicy: "disabled"; captureVerified: false }> {
    if (!isHex(id, 32)) refuse("malformed", 400); const known = input === undefined ? null : await this.binding(input); if (known && known.installationId !== id) refuse("malformed", 400);
    const directory = await this.directory(), file = path.join(directory, id + ".json"), ownerKey = capabilityOwnerKey(await realpath(this.store.db.filename));
    return this.lease(directory, id, async () => {
      const before = this.store.readInstallation(id), binding = before?.binding ?? known; if (!binding) return { status: "configuration_preserved", capturePolicy: "disabled", captureVerified: false };
      if (before) this.store.disableInstallation(id);
      const removed = await updateClaudeSettings(binding.settingsPath, "uninstall", { installationId: id, executable: binding.executable, capabilityFile: file });
      try { const descriptor = await readClaudeCapabilityDescriptor(file, id, ownerKey); if (descriptor.state === "disabled" || descriptor.token !== null && before && hookDigest(descriptor.token) === before.row.token_sha256) { const stats = await lstat(file, { bigint: true }); const current = await lstat(file, { bigint: true }); if (sameFile(stats, current)) await unlink(file); } } catch { /* Uncertain private-file ownership is preserved after authority revocation. */ }
      return { status: removed.status === "accepted" ? "removed" : "configuration_preserved", capturePolicy: "disabled", captureVerified: false };
    });
  }
  async doctor(id: string, input?: InstallationBinding) {
    if (!isHex(id, 32)) refuse("malformed", 400); const known = input === undefined ? null : await this.binding(input); if (known && known.installationId !== id) refuse("malformed", 400);
    const before = this.store.readInstallation(id), binding = before?.binding ?? known; if (!binding) return { configuration: "missing", capturePolicy: "unavailable", transport: "unavailable", captureVerified: false, captureCoverage: "inactive" } as const;
    const file = path.join(await realpath(path.dirname(this.store.db.filename)), "coding-hooks/claude", id + ".json"), ownerKey = capabilityOwnerKey(await realpath(this.store.db.filename));
    const config = await inspectClaudeHookSettings(binding.settingsPath, { installationId: id, executable: binding.executable, capabilityFile: file });
    if (!before) return { ...config, capability: "unavailable", capturePolicy: "inactive", owner: "inactive", captureMode: "metadata", settingsScope: binding.scope, captureCoverage: "inactive", registrationCount: 0, transport: "unavailable", captureVerified: false } as const;
    let capability: "available" | "unavailable" = "unavailable";
    try { const value = await readClaudeCapabilityDescriptor(file, id, ownerKey); if (value.state === "active" && value.token !== null && hookDigest(value.token) === before.row.token_sha256 && value.installationGeneration === before.row.generation && this.store.isOwnerActive() && value.ownerGeneration === this.store.currentOwnerGeneration() && (!this.transportActive || value.origin === this.transportOrigin)) capability = "available"; } catch { /* Diagnostic only; no private token is exposed. */ }
    return { ...config, capability, capturePolicy: this.store.isOwnerActive() ? before.row.state : "inactive", owner: this.store.isOwnerActive() ? "active" : "inactive", captureMode: before.row.capture_mode, settingsScope: before.binding.scope, captureCoverage: before.binding.scope === "global" && before.registrations.length > 1 ? "registered_workspaces" as const : "registered_workspace_only" as const, registrationCount: before.registrations.length, transport: this.transportActive && capability === "available" && this.transportOrigin !== null ? "available" as const : "unavailable" as const, captureVerified: false as const };
  }
}
