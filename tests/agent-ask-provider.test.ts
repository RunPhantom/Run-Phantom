import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type http from "node:http";
import { closeDb, clearAll, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";

const realFetch = globalThis.fetch;
const envNames = ["RUNPHANTOM_DB_PATH", "RUNPHANTOM_SECRET_STORE_PATH", "OPENAI_API_KEY", "RUNPHANTOM_OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
const originalEnv = new Map<string, string | undefined>();
const calls: Array<{ url: string; headers: Headers; body: any }> = [];
let directory: string, base: string, server: http.Server;
beforeAll(async () => {
  for (const key of envNames) { originalEnv.set(key, process.env[key]); delete process.env[key]; }
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), "runphantom-ask-provider-"));
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "traces.db");
  process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, "secrets.json");
  process.env.OPENAI_API_KEY = "synthetic-openai-ask-key";
  process.env.ANTHROPIC_API_KEY = "synthetic-anthropic-ask-key";
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== "https://api.openai.com/v1/chat/completions" && url !== "https://api.anthropic.com/v1/messages") {
      throw new Error("Unexpected outbound request in ask-provider fixture");
    }
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json(url.includes("openai") ? { choices: [{ message: { content: "Fixture answer" } }] } : { content: [{ type: "text", text: "Fixture answer" }] });
  }, { preconnect: realFetch.preconnect }) as typeof fetch;
  ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() => { clearAll(); calls.length = 0; });
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = realFetch; closeDb();
  for (const [key, value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(directory, { recursive: true, force: true });
});
function seed(provider: string, model: string, messages: unknown[] = [{ role: "user", content: "Captured question" }]) {
  const db = getDrizzleDb().$client;
  db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('source','Captured source',1,2)").run();
  db.query(`INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,model,provider,start_time_ms,end_time_ms)
    VALUES('source','generation','Captured generation','LLM_GENERATION','OK',?,'Captured answer',?,?,1,2)`)
    .run(JSON.stringify({ system: "Captured system", messages }), model, provider);
}
async function ask(model?: string) {
  const response = await realFetch(`${base}/api/agents/ask`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: "source", question: "Explain the captured result", ...(model === undefined ? {} : { model }) }) });
  return { httpStatus: response.status, body: await response.json() as any };
}

describe("ask-agent model override provider routing", () => {
  test("Anthropic trace with explicit OpenAI model uses OpenAI endpoint, key and request shape", async () => {
    seed("anthropic", "claude-haiku-4-5", [{ role: "user", content: [{ type: "text", text: "Captured question", cache_control: { type: "ephemeral" } }] }]);
    const result = await ask("gpt-4.1-mini");
    expect(result.body).toMatchObject({ status: "answered", provider: "openai", model: "gpt-4.1-mini", answer: "Fixture answer" });
    expect(calls).toHaveLength(1); expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe("Bearer synthetic-openai-ask-key"); expect(calls[0].headers.has("x-api-key")).toBe(false);
    expect(calls[0].body).toMatchObject({ model: "gpt-4.1-mini", max_completion_tokens: 4096 });
    expect(calls[0].body).not.toHaveProperty("system"); expect(calls[0].body).not.toHaveProperty("max_tokens");
    expect(calls[0].body.messages.slice(0, 3)).toEqual([{ role: "system", content: "Captured system" }, { role: "user", content: "Captured question" }, { role: "assistant", content: "Captured answer" }]);
  });
  test("OpenAI trace with explicit Anthropic model uses Anthropic endpoint, key and request shape", async () => {
    seed("openai", "gpt-4.1-mini", [{ role: "user", content: [{ type: "text", text: "Captured question" }] }]);
    const result = await ask("claude-haiku-4-5");
    expect(result.body).toMatchObject({ status: "answered", provider: "anthropic", model: "claude-haiku-4-5" });
    expect(calls).toHaveLength(1); expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers.get("x-api-key")).toBe("synthetic-anthropic-ask-key"); expect(calls[0].headers.has("authorization")).toBe(false);
    expect(calls[0].body).toMatchObject({ system: "Captured system", max_tokens: 4096 }); expect(calls[0].body).not.toHaveProperty("max_completion_tokens");
    expect(calls[0].body.messages[0]).toEqual({ role: "user", content: "Captured question" });
  });
  test("no override preserves captured provider provenance and existing same-provider block cleaning", async () => {
    const blocks = [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" }, cache_control: { type: "ephemeral" } }];
    seed("anthropic", "opaque-captured-model", [{ role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "Captured README" }] }]);
    expect((await ask()).body).toMatchObject({ status: "answered", provider: "anthropic", model: "opaque-captured-model" });
    expect(calls[0].body.messages[0].content).toEqual([{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } }]);
    expect(calls[0].body.messages[1].content[0].type).toBe("tool_result");
    clearAll(); calls.length = 0; seed("openai", "opaque-openai-model");
    expect((await ask()).body).toMatchObject({ status: "answered", provider: "openai", model: "opaque-openai-model" });
    expect(calls[0].url).toContain("api.openai.com");
  });
  test("same-provider explicit overrides preserve captured block handling", async () => {
    seed("anthropic", "claude-old", [{ role: "user", content: [{ type: "text", text: "Keep same provider", cache_control: { type: "ephemeral" } }] }]);
    expect((await ask("claude-haiku-4-5")).body.provider).toBe("anthropic");
    expect(calls[0].body.messages[0].content).toEqual([{ type: "text", text: "Keep same provider" }]);
    clearAll(); calls.length = 0;
    seed("openai", "gpt-old", [{ role: "user", content: [{ type: "text", text: "Keep OpenAI shape" }] }]);
    expect((await ask("gpt-4.1-mini")).body.provider).toBe("openai");
    expect(calls[0].body.messages[1].content).toEqual([{ type: "text", text: "Keep OpenAI shape" }]);
  });
  test("cross-provider continuation preserves captured plain-text tool history from source traces", async () => {
    seed("anthropic", "claude-haiku-4-5", [{ role: "tool", content: "8 test files, 48 tests passed", tool_call_id: "historical-call" }]);
    expect((await ask("gpt-4.1-mini")).body.status).toBe("answered");
    expect(calls[0].body.messages[1]).toEqual({ role: "user", content: "8 test files, 48 tests passed" });
    expect(calls[0].body).not.toHaveProperty("tools");
  });
  test("unsupported explicit model families never fall back to the trace provider or contact either endpoint", async () => {
    seed("anthropic", "claude-haiku-4-5");
    for (const model of ["gemini-2.5-flash", "opaque-custom-model"]) {
      const result = await ask(model); expect(result.httpStatus).toBe(422);
      expect(result.body).toMatchObject({ status: "unsupported_provider", model });
    }
    expect(calls).toHaveLength(0);
  });
  test("cross-provider non-text blocks and tool-call metadata are rejected before malformed provider requests", async () => {
    for (const message of [
      { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "Result" }] },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "Private reasoning", signature: "fixture" }] },
      { role: "assistant", content: "", tool_calls: [{ id: "call", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    ]) {
      clearAll(); seed("anthropic", "claude-haiku-4-5", [message]);
      const result = await ask("gpt-4.1-mini"); expect(result.httpStatus).toBe(422); expect(result.body.status).toBe("unsupported_context");
    }
    expect(calls).toHaveLength(0);
  });
});
