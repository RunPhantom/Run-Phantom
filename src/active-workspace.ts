import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "node:crypto";

const STATE_PATH = path.join(os.homedir(), ".runphantom", "active-workspace.json");
export const ACTIVE_WORKSPACE_MISSING_MESSAGE =
  "No active Run Phantom project. Run `runphantom` from your agent project.";

export interface ActiveWorkspace {
  cwd: string;
  updated_at: string;
}

export interface SelectedActiveWorkspace extends ActiveWorkspace { revision: string }

/** A selection lease must describe persisted bytes, never the legacy per-read fallback. */
export function getSelectedActiveWorkspace(): SelectedActiveWorkspace | null {
  let descriptor: number | undefined;
  try {
    const named = fs.lstatSync(STATE_PATH, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.size < 2n || named.size > 8192n) return null;
    descriptor = fs.openSync(STATE_PATH, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino || before.size !== named.size) return null;
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(STATE_PATH, { bigint: true });
    const identity = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(":");
    if (count !== Number(before.size) || identity(before) !== identity(after) || identity(after) !== identity(current) || !current.isFile() || current.isSymbolicLink()) return null;
    const raw = bytes.subarray(0, count);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const string = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
    // The persisted format has exactly two string fields. This refuses duplicate/extra keys.
    const pair = `${string}\\s*:\\s*${string}`;
    if (!new RegExp(`^\\s*\\{\\s*${pair}\\s*,\\s*${pair}\\s*\\}\\s*$`).test(text)) return null;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const values = parsed as Record<string, unknown>;
    if (Object.keys(values).length !== 2 || typeof values.cwd !== "string" || typeof values.updated_at !== "string"
      || !path.isAbsolute(values.cwd) || values.cwd.length > 4096 || [...values.cwd].some(character => {
        const code = character.codePointAt(0)!;
        return code < 32 || code >= 127 && code <= 159 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069 || code >= 0xd800 && code <= 0xdfff;
      })
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(values.updated_at) || !Number.isFinite(Date.parse(values.updated_at))) return null;
    const cwd = fs.realpathSync(values.cwd);
    const directory = fs.statSync(cwd, { bigint: true });
    if (!directory.isDirectory()) return null;
    const revision = createHash("sha256").update(raw).update(identity(after)).update(cwd).update(`${directory.dev}:${directory.ino}`).digest("hex");
    return { cwd, updated_at: values.updated_at, revision };
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function getActiveWorkspace(): ActiveWorkspace | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<ActiveWorkspace>;
    if (typeof parsed.cwd === "string" && path.isAbsolute(parsed.cwd) && fs.existsSync(parsed.cwd)) {
      return {
        cwd: parsed.cwd,
        updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
      };
    }
  } catch {
    return getProcessWorkspace();
  }
  return getProcessWorkspace();
}

export function setActiveWorkspace(cwd: string): ActiveWorkspace {
  const resolved = path.resolve(cwd);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`active workspace must be a directory: ${resolved}`);
  }

  const workspace = {
    cwd: resolved,
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(workspace, null, 2) + "\n");
  return workspace;
}

function getProcessWorkspace(): ActiveWorkspace | null {
  const cwd = process.cwd();
  try {
    if (path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()) {
      return { cwd, updated_at: new Date().toISOString() };
    }
  } catch {
    return null;
  }
  return null;
}
