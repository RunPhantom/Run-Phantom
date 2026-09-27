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

// The search stops at the repository root, the parent of examples/. A .env
// above the checkout (say ~/Downloads/.env) belongs to something else and can
// hold unrelated credentials.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function ancestorDirsWithinRepo(start: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(start);
  while (true) {
    dirs.push(current);
    if (current === REPO_ROOT) {
      return dirs.reverse();
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return [];
    }
    current = parent;
  }
}

export function loadWorkspaceEnv(moduleUrl: string): void {
  const initialKeys = new Set(Object.keys(process.env));
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const searchDirs = new Set<string>([
    ...ancestorDirsWithinRepo(process.cwd()),
    ...ancestorDirsWithinRepo(moduleDir),
  ]);

  for (const dir of searchDirs) {
    loadEnvFile(path.join(dir, ".env"), initialKeys);
    loadEnvFile(path.join(dir, ".env.local"), initialKeys);
  }
}
