import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installSkillsFromSource,
  isSkillAgentType,
  type FailedSkillRecord,
  type InstalledSkillRecord,
  type SkillAgentType,
} from "agent-install/skill";
import {
  installMcpServerForAgent,
  isMcpAgentType,
  type McpServerConfig,
} from "agent-install/mcp";
import { IS_PACKAGED_RUNTIME, VERSION } from "../version";
import { materializeSkillBundle } from "./bundle";
import {
  installCustomMcpServerForAgent,
  supportsCustomMcpAgent,
  type CustomMcpInstallResult,
} from "./custom-mcp";
import {
  entryFromInstallPlanItem,
  loadInstallRegistry,
  saveInstallRegistry,
  upsertInstallRegistryEntry,
} from "./registry";
import {
  CANONICAL_MCP_SERVER_NAME,
  removeOwnedMcpEntries,
  type RemoveOwnedResult,
} from "./owned-mcp";
import type { InstallAgentId, InstallPlan } from "./types";

export interface ApplyInstallOptions {
  binPath?: string;
  registryFile?: string;
  bundleRoot?: string;
}

export interface ReplacedMcpEntry {
  serverName: string;
  matchedBy: "args" | "command";
}

export interface FailedMcpCleanup {
  serverName: string;
  matchedBy: "args" | "command";
  error?: string;
}

export interface ApplyInstallItemResult {
  agent: InstallAgentId;
  skillsInstalled: InstalledSkillRecord[];
  skillsFailed: FailedSkillRecord[];
  mcp: CustomMcpInstallResult;
  mcpReplaced: ReplacedMcpEntry[];
  mcpCleanupFailed: FailedMcpCleanup[];
  // Distinct from per-entry failures: the target config could not be inspected.
  mcpCleanupError?: string;
}

export interface ApplyInstallResult {
  bundlePath: string;
  items: ApplyInstallItemResult[];
}

interface ResolveMcpConfigRuntime {
  execPath: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  defaultBinPath: string;
  isPackagedRuntime: boolean;
}

const RUNPHANTOM_BIN_PATH_ENV = "RUNPHANTOM_BIN_PATH";
const MCP_ARGS = ["mcp"] as const;

function absolutePath(file: string, cwd: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

function sourceEntrypoint(argv: string[], cwd: string): string | null {
  const entry = argv[1];
  if (!entry || !/\.(c|m)?[jt]s$/.test(entry)) return null;

  const resolved = absolutePath(entry, cwd);
  return fs.existsSync(resolved) ? resolved : null;
}

function resolveMcpServerConfig(
  override: string | undefined,
  runtime: ResolveMcpConfigRuntime = {
    execPath: process.execPath,
    argv: process.argv,
    env: process.env,
    cwd: process.cwd(),
    defaultBinPath: path.join(os.homedir(), ".runphantom", "bin", "runphantom"),
    isPackagedRuntime: IS_PACKAGED_RUNTIME,
  },
): McpServerConfig {
  if (override) {
    return { command: path.resolve(override), args: [...MCP_ARGS] };
  }

  const envBin = runtime.env[RUNPHANTOM_BIN_PATH_ENV];
  if (envBin) {
    return { command: absolutePath(envBin, runtime.cwd), args: [...MCP_ARGS] };
  }

  if (runtime.isPackagedRuntime) {
    return { command: runtime.execPath, args: [...MCP_ARGS] };
  }

  const sourceEntry = sourceEntrypoint(runtime.argv, runtime.cwd);
  if (sourceEntry) {
    return { command: runtime.execPath, args: [sourceEntry, ...MCP_ARGS] };
  }

  if (fs.existsSync(runtime.defaultBinPath)) {
    return { command: runtime.defaultBinPath, args: [...MCP_ARGS] };
  }

  throw new Error(
    `install: could not resolve a runnable Run Phantom binary for MCP. ` +
      `Run setup with --bin-path=<path>, or reinstall Run Phantom so ${runtime.defaultBinPath} exists.`,
  );
}

function collectReplacedEntries(removed: RemoveOwnedResult[]): ReplacedMcpEntry[] {
  const out: ReplacedMcpEntry[] = [];
  for (const r of removed) {
    if (r.removed && r.entry.serverName !== CANONICAL_MCP_SERVER_NAME) {
      out.push({ serverName: r.entry.serverName, matchedBy: r.entry.matchedBy });
    }
  }
  return out;
}

function collectCleanupFailures(removed: RemoveOwnedResult[]): FailedMcpCleanup[] {
  const out: FailedMcpCleanup[] = [];
  for (const r of removed) {
    if (!r.removed && r.entry.serverName !== CANONICAL_MCP_SERVER_NAME) {
      out.push({ serverName: r.entry.serverName, matchedBy: r.entry.matchedBy, error: r.error });
    }
  }
  return out;
}

export function mcpCleanupWarnings(item: ApplyInstallItemResult): string[] {
  const out: string[] = [];
  for (const failed of item.mcpCleanupFailed) {
    const detail = failed.error ? `: ${failed.error}` : "";
    out.push(`left a non-canonical MCP entry '${failed.serverName}' in ${item.agent} config — remove it manually${detail}`);
  }
  if (item.mcpCleanupError) {
    out.push(
      `could not inspect ${item.agent} config for duplicate MCP entries — check it manually: ${item.mcpCleanupError}`,
    );
  }
  return out;
}

function assertFullSupport(agent: InstallAgentId, scope: "global" | "local"): asserts agent is SkillAgentType {
  if (!isSkillAgentType(agent) || (!isMcpAgentType(agent) && !supportsCustomMcpAgent(agent, scope))) {
    throw new Error(`install: ${agent} does not support both Run Phantom skills and MCP`);
  }
}

export async function applyInstallPlan(
  plan: InstallPlan,
  opts: ApplyInstallOptions = {},
): Promise<ApplyInstallResult> {
  const bundle = await materializeSkillBundle(opts.bundleRoot);
  const mcpConfig = resolveMcpServerConfig(opts.binPath);
  const registry = loadInstallRegistry(opts.registryFile);
  const results: ApplyInstallItemResult[] = [];

  for (const item of plan.items) {
    assertFullSupport(item.agent, item.scope);
    const isGlobal = item.scope === "global";
    const cwd = item.cwd ?? process.cwd();

    const skills = await installSkillsFromSource({
      source: bundle.skillsDir,
      agents: [item.agent],
      global: isGlobal,
      cwd,
      mode: "symlink",
    });

    const mcp = isMcpAgentType(item.agent)
      ? installMcpServerForAgent(CANONICAL_MCP_SERVER_NAME, mcpConfig, item.agent, {
          global: isGlobal,
          cwd,
        })
      : installCustomMcpServerForAgent(CANONICAL_MCP_SERVER_NAME, mcpConfig, item.agent, item.scope);

    let removedPriorEntries: RemoveOwnedResult[] = [];
    let mcpCleanupError: string | undefined;
    if (mcp.success) {
      try {
        removedPriorEntries = removeOwnedMcpEntries({
          agent: item.agent,
          scope: item.scope,
          cwd,
          excludeServerName: CANONICAL_MCP_SERVER_NAME,
        });
      } catch (err) {
        mcpCleanupError = err instanceof Error ? err.message : String(err);
      }
    }

    const mcpReplaced = collectReplacedEntries(removedPriorEntries);
    const mcpCleanupFailed = collectCleanupFailures(removedPriorEntries);

    results.push({
      agent: item.agent,
      skillsInstalled: skills.installed,
      skillsFailed: skills.failed,
      mcp,
      mcpReplaced,
      mcpCleanupFailed,
      mcpCleanupError,
    });

    if (skills.failed.length === 0 && mcp.success) {
      upsertInstallRegistryEntry(registry, entryFromInstallPlanItem(item, VERSION));
    }
  }

  saveInstallRegistry(registry, opts.registryFile);
  return { bundlePath: bundle.skillsDir, items: results };
}

export const _internal = {
  resolveMcpServerConfig,
  sourceEntrypoint,
  collectReplacedEntries,
  collectCleanupFailures,
  mcpCleanupWarnings,
  RUNPHANTOM_BIN_PATH_ENV,
};
