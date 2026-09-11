import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath: string, initialKeys: Set<string>): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!key || initialKeys.has(key)) {
      continue;
    }

    process.env[key] = parseEnvValue(normalized.slice(equalsIndex + 1));
  }
}

function ancestorDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(start);
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return dirs.reverse();
    }
    current = parent;
  }
}

export function loadWorkspaceEnv(moduleUrl: string): void {
  const initialKeys = new Set(Object.keys(process.env));
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const searchDirs = new Set<string>([
    ...ancestorDirs(process.cwd()),
    ...ancestorDirs(moduleDir),
  ]);

  for (const dir of searchDirs) {
    loadEnvFile(path.join(dir, ".env"), initialKeys);
    loadEnvFile(path.join(dir, ".env.local"), initialKeys);
  }
}
