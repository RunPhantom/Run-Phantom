import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "node:crypto";
import { hasDuplicateJsonKeys } from "./json-keys";
import { parseJsonEvidence } from "./evaluations/json-evidence";

const STATE_PATH = path.join(os.homedir(), ".runphantom", "active-workspace.json");
export const ACTIVE_WORKSPACE_MISSING_MESSAGE =
  "No active Run Phantom project. Run `runphantom` from your agent project.";

export interface ActiveWorkspace {
  cwd: string;
  updated_at: string;
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


/** ACP authority is the selected state file and current canonical directory, not a requested older cwd. */
export function getActiveWorkspaceSelection(): { cwd: string; generation: string } | null {
  let descriptor: number | undefined;
  try {
    let value: unknown;
    let source = "process_workspace";
    let sourceIdentity = "absent_state";
    try {
      descriptor = fs.openSync(STATE_PATH, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.size > 16_384n) return null;
      const buffer = Buffer.alloc(16_385);
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const current = fs.lstatSync(STATE_PATH, { bigint: true });
      if (length > 16_384 || BigInt(length) !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) return null;
      sourceIdentity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}:${before.birthtimeNs}`;
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      value = parseJsonEvidence(source);
      if (hasDuplicateJsonKeys(source)) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      value = { cwd: process.cwd() };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const cwd = (value as Record<string, unknown>).cwd;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) return null;
    const canonical = fs.realpathSync(cwd);
    const directory = fs.statSync(canonical, { bigint: true });
    if (!directory.isDirectory()) return null;
    return { cwd: canonical, generation: createHash("sha256").update(sourceIdentity).update("\0").update(source).update("\0").update(canonical).update(`\0${directory.dev}:${directory.ino}`).digest("hex") };
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
