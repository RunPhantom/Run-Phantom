import { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDbPath, getDrizzleDb } from "../db";
import { capabilityOwnerKey } from "./capability";
import { executeHookManagement, parseHookManagementCommand, type HookManagementCommand } from "./configuration";
import { ClaudeHookManagement } from "./management";
import { CodingHookStore } from "./store";
import { parseTransitionV2 } from "./context-v2";
import { hookDigest, isHex } from "./protocol";

function command(argv: string[]): HookManagementCommand {
  const action = argv[0]; if (!["install", "uninstall", "doctor", "unregister"].includes(action) || argv[1] !== "claude") throw new Error("usage: runphantom hooks install|uninstall|doctor|unregister claude [--global|--local] [--cwd PATH] [--full --consent-full]");
  let scope = "global", workspace = process.cwd(), captureMode = "metadata", fullConsent = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--global") scope = "global";
    else if (argv[i] === "--local") scope = "local";
    else if (argv[i] === "--cwd" && argv[i + 1]) workspace = path.resolve(argv[++i]);
    else if (argv[i] === "--full") captureMode = "full";
    else if (argv[i] === "--consent-full") fullConsent = true;
    else throw new Error("unknown hooks management argument");
  }
  return parseHookManagementCommand({ action, scope, workspace, captureMode, fullConsent });
}
function managementPort(): number {
  let raw = process.env.RUNPHANTOM_PORT;
  if (!raw) try { raw = readFileSync(path.join(os.homedir(), ".runphantom/runphantom.port"), "utf8").trim(); } catch { raw = "5947"; }
  if (!raw || !/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 65535) throw new Error("invalid configured daemon port"); return Number(raw);
}
async function submitHookManagement(input: unknown, offline?: () => Promise<unknown>): Promise<unknown> {
  const db = getDrizzleDb().$client, ownerKey = capabilityOwnerKey(realpathSync(db.filename));
  const timer = new AbortController(), timeout = setTimeout(() => timer.abort(), 3000);
  try {
    let response: Response;
    try { response = await fetch(`http://127.0.0.1:${managementPort()}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": ownerKey }, body: JSON.stringify(input), redirect: "error", signal: timer.signal }); }
    catch (error) {
      if (!offline || timer.signal.aborted || !(error instanceof Error) || !("code" in error) || !["ECONNREFUSED", "ConnectionRefused"].includes(String(error.code))) throw new Error("Hook management daemon unavailable; current authority was not changed");
      // Offline configuration is deliberately disabled and cannot begin or borrow daemon ownership.
      return offline();
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Hook management refused (${response.status})`); }
    if (!response.body) throw new Error("Hook management response unavailable");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 16384) throw new Error("Hook management response limit"); chunks.push(next.value); }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    } finally { await reader.cancel().catch(() => {}); }
  } finally { clearTimeout(timeout); }
}
export async function manageClaudeHooks(input: HookManagementCommand): Promise<unknown> {
  input = parseHookManagementCommand(input);
  return submitHookManagement(input, () => executeHookManagement(new ClaudeHookManagement(new CodingHookStore(getDrizzleDb().$client)), input));
}
/** Current CAS is read from the selected profile; only the running owner can grant activation. */
export async function manageClaudeContextActivation(installationIds: string[]): Promise<unknown> {
  if (!Array.isArray(installationIds) || !installationIds.length || installationIds.length > 64 || installationIds.some(id => !isHex(id, 32)) || new Set(installationIds).size !== installationIds.length) throw new Error("Invalid selected hook installations");
  const ids = [...installationIds].sort(), db = getDrizzleDb().$client, store = new CodingHookStore(db, {}, undefined, { contextTransport: true });
  const owner = db.query("SELECT CASE WHEN length(generation)=32 THEN generation END generation FROM coding_hook_owner WHERE id=1").get() as { generation: string } | null;
  if (!owner || !isHex(owner.generation, 32)) throw new Error("Hook management daemon unavailable; current authority was not changed");
  const input = { action: "activate-context-v2", installationIds: ids, expectedOwnerGeneration: owner.generation, expectedInstallations: ids.map(id => {
    const installed = store.readInstallation(id); if (!installed) throw new Error("Unknown selected hook installation");
    return { installationId: id, generation: installed.row.generation, configSha256: installed.row.config_sha256, catalogSha256: hookDigest(installed.row.data!) };
  }) };
  parseTransitionV2(JSON.stringify(input));
  return submitHookManagement(input);
}
function activationIds(argv: string[]): string[] {
  if (argv[1] !== "claude" || argv.length < 4 || argv.length > 130 || argv.length % 2) throw new Error("usage: runphantom hooks activate-context-v2 claude --installation-id HEX32 [--installation-id HEX32]");
  const ids: string[] = [];
  for (let offset = 2; offset < argv.length; offset += 2) { if (argv[offset] !== "--installation-id" || !isHex(argv[offset + 1], 32)) throw new Error("Invalid selected hook installations"); ids.push(argv[offset + 1]); }
  return ids;
}
export async function cmdCodingHooks(argv: string[]): Promise<number> {
  if (argv[1] === "codex") {
    const { cmdCodexHooks } = await import("./codex-install");
    return cmdCodexHooks(argv);
  }
  try { console.log(JSON.stringify(await (argv[0] === "activate-context-v2" ? manageClaudeContextActivation(activationIds(argv)) : manageClaudeHooks(command(argv))))); return 0; }
  catch (error) { console.error(error instanceof Error ? error.message : "Hook management unavailable"); return 64; }
  finally { closeDb(); }
}
/** Existing uninstall must revoke owned hook policies before deleting the binary or local state. */
export async function removeConfiguredClaudeHooks(databasePath = getDbPath()): Promise<number> {
  if (!existsSync(databasePath)) return 0;
  const db = new Database(realpathSync(databasePath), { create: false, readwrite: true });
  try {
    if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='coding_hook_installations'").get()) return 0;
    const manager = new ClaudeHookManagement(new CodingHookStore(db));
    const rows = db.query("SELECT id FROM coding_hook_installations ORDER BY id LIMIT 65").all() as { id: string }[]; if (rows.length > 64) throw new Error("Hook installation quota");
    for (const row of rows) if ((await manager.uninstall(row.id)).status !== "removed") throw new Error("Uncertain hook configuration ownership"); return rows.length;
  } finally { db.close(true); }
}
