import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstallAgentId, InstallPlanItem, InstallScope } from "./types";

export const INSTALL_REGISTRY_VERSION = 1 as const;

export interface InstallRegistryEntry {
  id: string;
  agent: InstallAgentId;
  scope: InstallScope;
  cwd: string | null;
  installer: "agent-install";
  runPhantomVersion: string;
  installedAt: string;
  updatedAt: string;
}

export interface InstallRegistry {
  version: typeof INSTALL_REGISTRY_VERSION;
  installs: InstallRegistryEntry[];
}

export function defaultInstallRegistryPath(): string {
  return path.join(os.homedir(), ".runphantom", "install-registry.json");
}

export function emptyInstallRegistry(): InstallRegistry {
  return { version: INSTALL_REGISTRY_VERSION, installs: [] };
}

export function loadInstallRegistry(file: string = defaultInstallRegistryPath()): InstallRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyInstallRegistry();
    throw err;
  }
  if (raw.trim() === "") return emptyInstallRegistry();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[install-registry] ${file} exists but is not valid JSON: ${(err as Error).message}.`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== INSTALL_REGISTRY_VERSION ||
    !Array.isArray((parsed as { installs?: unknown }).installs)
  ) {
    throw new Error(
      `[install-registry] ${file} schema unrecognized. Expected { version: ${INSTALL_REGISTRY_VERSION}, installs: [] }.`,
    );
  }

  return parsed as InstallRegistry;
}

export function saveInstallRegistry(
  registry: InstallRegistry,
  file: string = defaultInstallRegistryPath(),
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2) + "\n");
}

export function installRegistryId(
  agent: InstallAgentId,
  scope: InstallScope,
  cwd: string | null,
): string {
  return scope === "global" ? `global:${agent}` : `local:${agent}:${cwd ?? ""}`;
}

export function upsertInstallRegistryEntry(
  registry: InstallRegistry,
  entry: InstallRegistryEntry,
): InstallRegistry {
  const idx = registry.installs.findIndex((existing) => existing.id === entry.id);
  if (idx === -1) {
    registry.installs.push(entry);
  } else {
    registry.installs[idx] = {
      ...entry,
      installedAt: registry.installs[idx].installedAt,
    };
  }
  return registry;
}

export function entryFromInstallPlanItem(
  item: InstallPlanItem,
  runPhantomVersion: string,
  now: () => string = () => new Date().toISOString(),
): InstallRegistryEntry {
  const stamp = now();
  return {
    id: installRegistryId(item.agent, item.scope, item.cwd),
    agent: item.agent,
    scope: item.scope,
    cwd: item.cwd,
    installer: "agent-install",
    runPhantomVersion,
    installedAt: stamp,
    updatedAt: stamp,
  };
}
