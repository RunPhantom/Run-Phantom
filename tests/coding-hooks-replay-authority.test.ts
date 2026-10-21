import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeStoredSpan } from "../src/spans/normalize";
import { captureCompletion, observationReplayUnavailable } from "../src/spans/normalized";

test("validated Codex observation refuses override/context before side effects while actual SDK replay stays usable", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hook-replay-authority-")));
  const home = path.join(directory, "home"), workspace = path.join(directory, "workspace with spaces");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  try {
    const child = spawnSync(process.execPath, ["--no-env-file", path.join(import.meta.dir, "fixtures/coding-hooks-replay-authority.ts")], { cwd: workspace, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: directory, TMP: directory, TEMP: directory, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", RUNPHANTOM_DB_PATH: path.join(home, "private.sqlite"), RUNPHANTOM_SECRET_STORE_PATH: path.join(home, "secrets.json"), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RUNPHANTOM_CLAUDE_CLI_CHAT: "0" }, timeout: 12000, encoding: "utf8" });
    if (child.error || child.status !== 0) console.error(child.stdout, child.stderr);
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    const value = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { observation: { validated: boolean; events: string; contextStatus: number; context: { code: string }; health: number; posts: number; rowsUnchanged: boolean; agentConfigUnchanged: boolean }; mixedObservation: { events: string; rowsUnchanged: boolean; noAgentCalls: boolean }; ordinaryPositive: { events: string; health: number; posts: number; normalizedSdk: boolean }; ordinaryNegative: { events: string; noAgentCalls: boolean } };
    expect(value.observation.validated).toBe(true);
    expect(value.observation.events).toContain('"code":"observation_not_replayable"');
    expect(value.observation.contextStatus).toBe(422); expect(value.observation.context.code).toBe("observation_not_replayable");
    expect(value.observation).toMatchObject({ health: 0, posts: 0, rowsUnchanged: true, agentConfigUnchanged: true });
    expect(value.mixedObservation.events).toContain('"code":"observation_not_replayable"'); expect(value.mixedObservation).toMatchObject({ rowsUnchanged: true, noAgentCalls: true });
    expect(value.ordinaryPositive.normalizedSdk).toBe(true); expect(value.ordinaryPositive.events).toContain('"type":"replay_complete"');
    expect(value.ordinaryPositive.health).toBeGreaterThan(0); expect(value.ordinaryPositive.posts).toBeGreaterThan(0);
    expect(value.ordinaryNegative.events).toContain('"code":"no_replayable_context"'); expect(value.ordinaryNegative.noAgentCalls).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15000);

test("completion uncertainty alone does not change existing validated Claude or ordinary SDK replay semantics", () => {
  const attributes = { captureContract: "runphantom.claude-hook.observation/v1", captureModel: null, coverage: "partial", coverageReasons: [], currentCapturePolicy: "metadata", entityKind: "session", producerVerified: false, reportedDurationMs: null, reportedPhase: "unknown", retainedBody: false, retainedEntitySha256: "a".repeat(64), runtimeVerified: false, source: "claude_hook", sourceKind: "hook", usage: null };
  const claude = normalizeStoredSpan({ name: "Session observation", span_type: "AGENT_ROOT", input_payload: null, output_payload: null, attributes: JSON.stringify(attributes) }).normalized;
  expect(claude.capture?.contract).toBe("runphantom.claude-hook.observation/v1");
  expect(captureCompletion(claude.capture)).toBe("unavailable"); expect(observationReplayUnavailable(claude.capture)).toBe(false);
  const sdk = normalizeStoredSpan({ name: "ai.generateText", span_type: "LLM_GENERATION", input_payload: null, output_payload: null, attributes: JSON.stringify({ "ai.prompt": "Ordinary SDK prompt" }) }).normalized;
  expect(sdk.kind).toBe("llm"); expect(sdk.capture).toBeUndefined(); expect(observationReplayUnavailable(sdk.capture)).toBe(false);
  const unknown = normalizeStoredSpan({ name: "unknown", span_type: "AGENT_ROOT", input_payload: null, output_payload: null, attributes: JSON.stringify({ captureContract: "runphantom.codex-hook.observation/v999" }) }).normalized;
  expect(unknown.capture).toBeUndefined(); expect(observationReplayUnavailable(unknown.capture)).toBe(false);
});
