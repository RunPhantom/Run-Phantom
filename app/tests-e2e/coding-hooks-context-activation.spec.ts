import { test, expect } from "./fixtures";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { capabilityOwnerKey } from "../../src/coding-hooks/capability";
import { hookSession, transcriptRecord } from "../../tests/fixtures/coding-hooks-claude";

async function ownedChild(command: string, args: string[], input: string, env: NodeJS.ProcessEnv = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["FORCE_COLOR", "NO_COLOR", "NODE_OPTIONS"].includes(key) && !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)));
  const child = spawn(command, args, { env: { ...inherited, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", ...env }, stdio: "pipe" });
  let stdout = "", stderr = ""; child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value); child.stdin.on("error", () => {}); child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 3500), code = await new Promise(resolve => child.once("close", resolve)); clearTimeout(timer);
  expect(code).toBe(0); expect(stderr).toBe(""); return stdout;
}

test("manually activated installed independent agent outputs reach the live run UI with observed partial evidence", async ({ page, runPhantom }, testInfo) => {
  const profile = path.dirname(runPhantom.dbPath), workspace = path.join(profile, "context-workspace"); mkdirSync(workspace);
  const installed = await fetch(runPhantom.url + "/api/coding-hooks/claude/manage", { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": capabilityOwnerKey(runPhantom.dbPath) }, body: JSON.stringify({ action: "install", scope: "local", workspace, captureMode: "full", fullConsent: true }) });
  expect(installed.status).toBe(200); const receipt = await installed.json() as { installationId: string; captureVerified: boolean }; expect(receipt.captureVerified).toBe(false);
  const settings = JSON.parse(readFileSync(path.join(workspace, ".claude/settings.local.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> };
  const vector = (event: string) => settings.hooks[event].flatMap(group => group.hooks).find(handler => handler.args?.[4] === receipt.installationId)!;
  const activation = await ownedChild(vector("Stop").command, ["hooks", "activate-context-v2", "claude", "--installation-id", receipt.installationId], "", { RUNPHANTOM_DB_PATH: runPhantom.dbPath, RUNPHANTOM_PORT: String(runPhantom.port) });
  expect(JSON.parse(activation)).toEqual({ status: "configured", unchanged: false, captureVerified: false }); expect(activation).not.toMatch(/token|ownerGeneration|Bearer/);
  const project = path.join(profile, ".claude/projects", workspace.replace(/[^A-Za-z0-9.-]+/g, "-")), main = path.join(project, hookSession + ".jsonl"), agents = path.join(project, hookSession, "subagents"); mkdirSync(agents, { recursive: true });
  const record = (id: string, text: string, input: number, output: number) => transcriptRecord({ uuid: id, requestId: id, message: { id, model: "context-observation-model", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  writeFileSync(main, JSON.stringify(record("main_observation", "Main source output", 17, 5)) + "\n");
  const invoke = async (event: string, fields: Record<string, string> = {}) => {
    const installedVector = vector(event), output = await ownedChild(installedVector.command, installedVector.args, JSON.stringify({ session_id: hookSession, hook_event_name: event, cwd: workspace, transcript_path: main, ...fields })); expect(output).toBe("");
  };
  await invoke("Stop");
  for (const [id, text, input, output] of [["first_agent", "First independent source output", 3, 2], ["second_agent", "Second independent source output", 4, 1]] as const) {
    const file = path.join(agents, `agent-${id}.jsonl`); writeFileSync(file, JSON.stringify(record(id, text, input, output)) + "\n"); await invoke("SubagentStop", { agent_id: id, agent_type: "Task", agent_transcript_path: file });
  }
  const runs = await (await fetch(runPhantom.url + "/api/runs")).json() as { id: string }[]; expect(runs).toHaveLength(1);
  const detail = await (await fetch(runPhantom.url + "/api/runs/detail/" + runs[0].id)).json() as { spans: { span_type: string; input_tokens: number | null; output_tokens: number | null; attributes: string; normalized: { kind: string; capture: { contract: string; contextKey: string | null; coverage: string; runtimeVerified: boolean; producerVerified: boolean } } }[] };
  const models = detail.spans.filter(span => span.span_type === "LLM_GENERATION"); expect(models).toHaveLength(3); expect(models.reduce((sum, span) => sum + (span.input_tokens ?? 0), 0)).toBe(24); expect(models.reduce((sum, span) => sum + (span.output_tokens ?? 0), 0)).toBe(8);
  expect(new Set(models.map(span => span.normalized.capture.contextKey)).size).toBe(3); for (const span of models) expect(span.normalized).toMatchObject({ kind: "llm", capture: { contract: "runphantom.claude-hook.observation/v2", coverage: "partial", runtimeVerified: false, producerVerified: false } });
  await invoke("Stop"); const repeated = await (await fetch(runPhantom.url + "/api/runs/detail/" + runs[0].id)).json() as typeof detail; expect(repeated.spans).toEqual(detail.spans);
  await page.goto(runPhantom.url + "/runs/" + runs[0].id, { waitUntil: "networkidle" });
  await expect(page.getByText("Main source output", { exact: true })).toBeVisible(); await expect(page.getByText("First independent source output", { exact: true })).toBeVisible(); await expect(page.getByText("Second independent source output", { exact: true })).toBeVisible(); await expect(page.getByText(/producer.reported.*partial/i).first()).toBeVisible(); await expect(page.getByRole("button", { name: "Edit message and replay run" })).toHaveCount(0);
  for (const width of [360, 390, 768, 1024, 1440, 1920]) { await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready); await expect(page.getByText("Second independent source output", { exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`context-native-${width}.png`), fullPage: true }); }
});
