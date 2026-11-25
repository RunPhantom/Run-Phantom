import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { closeDb, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";
import { PROVIDER_SUMMARY } from "../src/summary-protocol";

let directory: string;
const saved = { db: process.env.RUNPHANTOM_DB_PATH, key: process.env.ANTHROPIC_API_KEY, fetch: globalThis.fetch };
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-summarize-"));
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "summary.db"); getDrizzleDb();
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
});
afterAll(() => {
  globalThis.fetch = saved.fetch; closeDb();
  for (const [name, value] of [["RUNPHANTOM_DB_PATH", saved.db], ["ANTHROPIC_API_KEY", saved.key]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  rmSync(directory, { recursive: true, force: true });
});

test("the summary route never contacts a provider without explicit consent for the named model", async () => {
  const providerCalls: { url: string; body: { model: string; messages: { content: string }[] } }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.anthropic.com/")) {
      providerCalls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Reviewed PR; tests failed." }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return saved.fetch(input, init);
  }) as typeof fetch;
  const { server } = await createServer(0);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown) => saved.fetch(`${origin}/api/summarize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const consent of [undefined, true, { provider: "anthropic" }, { provider: "openai", model: PROVIDER_SUMMARY.model }, { provider: "anthropic", model: "claude-sonnet-5-5" }, { provider: "anthropic", model: PROVIDER_SUMMARY.model, extra: 1 }]) {
      const response = await post({ content: "User: review my PR", consent });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ summary: null, available: false, reason: "consent_required" });
    }
    expect(providerCalls).toEqual([]);
    const accepted = await post({ content: "x".repeat(10_000), consent: { provider: "anthropic", model: PROVIDER_SUMMARY.model } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ summary: "Reviewed PR; tests failed." });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].body.model).toBe(PROVIDER_SUMMARY.model);
    expect(providerCalls[0].body.messages[0].content).toHaveLength(PROVIDER_SUMMARY.maxFieldChars * 3);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
