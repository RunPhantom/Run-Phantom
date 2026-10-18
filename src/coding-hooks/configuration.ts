import { lstat, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SOURCE_ROOT } from "../source-paths";
import { IS_PACKAGED_RUNTIME } from "../version";
import { registrationForBinding } from "./catalog";
import { ClaudeHookManagement, installationIdForSettings } from "./management";
import { refuse } from "./protocol";
import type { InstallationBinding } from "./store";

export interface HookManagementCommand { action: "install" | "uninstall" | "doctor" | "unregister"; scope: "global" | "local"; workspace: string; captureMode: "metadata" | "full"; fullConsent: boolean; }
export function parseHookManagementCommand(value: unknown): HookManagementCommand {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "action,captureMode,fullConsent,scope,workspace") refuse("malformed", 400);
  const input = value as Record<string, unknown>;
  if (!["install", "uninstall", "doctor", "unregister"].includes(input.action as string) || !["global", "local"].includes(input.scope as string) || !["metadata", "full"].includes(input.captureMode as string) || typeof input.fullConsent !== "boolean"
    || typeof input.workspace !== "string" || !path.isAbsolute(input.workspace) || path.normalize(input.workspace) !== input.workspace || input.workspace.includes("\0") || Buffer.byteLength(input.workspace) > 4096
    || input.scope === "global" && input.captureMode !== "metadata" || input.captureMode === "full" && input.fullConsent !== true || input.action === "unregister" && input.scope !== "global" || input.action !== "install" && (input.captureMode !== "metadata" || input.fullConsent)) refuse("malformed", 400);
  return input as unknown as HookManagementCommand;
}
async function prepareDirectory(directory: string): Promise<void> {
  let current = directory;
  for (let steps = 0; ; steps++) {
    if (steps >= 64) refuse("unknown_scope", 409);
    const stat = await lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current)) refuse("unknown_scope", 409);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) refuse("unknown_scope", 409);
}
/** Only trusted local management registers directories; hook claims cannot invoke this path. */
export async function configuredHookBinding(command: HookManagementCommand, create = false): Promise<InstallationBinding> {
  const workspace = await realpath(command.workspace), home = await realpath(os.homedir()); if (workspace !== command.workspace || !(await lstat(workspace)).isDirectory()) refuse("unknown_scope", 409);
  const config = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")), root = path.join(config, "projects");
  const candidates = [...new Set([workspace.replace(/[^A-Za-z0-9.-]+/g, "-"), workspace.replace(/\//g, "-")])].map(name => path.join(root, name));
  const existing: string[] = [];
  for (const candidate of candidates) { const stat = await lstat(candidate).catch(() => null); if (stat) { if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(candidate) !== candidate) refuse("unknown_scope", 409); existing.push(candidate); } }
  if (existing.length > 1) refuse("unknown_scope", 409);
  const projectDirectory = existing[0] ?? candidates[0];
  if (create) { await prepareDirectory(projectDirectory); if (command.scope === "local") await prepareDirectory(path.join(workspace, ".claude")); }
  const settingsPath = command.scope === "global" ? path.join(config, "settings.json") : path.join(workspace, ".claude/settings.local.json");
  const executable = await realpath(IS_PACKAGED_RUNTIME ? process.execPath : process.env.RUNPHANTOM_BIN_PATH || path.join(SOURCE_ROOT, "bin/runphantom-dev"));
  return { installationId: installationIdForSettings(command.scope, settingsPath), scope: command.scope, captureMode: command.captureMode, workspace: command.scope === "global" ? null : workspace, registeredWorkspace: workspace, transcriptRoot: root, projectDirectory, homeDirectory: home, settingsPath, executable };
}
export async function executeHookManagement(manager: ClaudeHookManagement, command: HookManagementCommand): Promise<unknown> {
  if (command.action === "unregister") {
    const home = await realpath(os.homedir()), config = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"));
    const id = installationIdForSettings("global", path.join(config, "settings.json")), prior = manager.store.readInstallation(id);
    const registration = prior?.registrations.find(value => value.registeredWorkspace === command.workspace);
    if (!registration) refuse("unknown_scope", 409); return manager.unregister(id, registration.registrationId);
  }
  const binding = await configuredHookBinding(command, command.action === "install");
  if (command.action === "doctor") return manager.doctor(binding.installationId, binding);
  if (command.action === "uninstall") return manager.uninstall(binding.installationId, binding);
  const prior = manager.store.readInstallation(binding.installationId);
  const registrations = binding.scope === "global" ? [...(prior?.registrations ?? []).filter(value => value.registeredWorkspace !== binding.registeredWorkspace), registrationForBinding(binding)] : undefined;
  return manager.install(binding.scope === "global" && prior ? prior.binding : binding, { fullConsent: command.fullConsent, registrations });
}
