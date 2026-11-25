import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkProviderConnection } from "../src/provider-connection";
import { maskSecret, PROVIDER_MODELS_ENDPOINT } from "../src/provider-connection-protocol";
import { RUNPHANTOM_SECRET_STORE_PATH_ENV, setStoredSecret } from "../src/secret-store";

const names = [RUNPHANTOM_SECRET_STORE_PATH_ENV, "OPENAI_API_KEY", "RUNPHANTOM_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const original = new Map(names.map(name => [name, process.env[name]]));
let root = "";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  for (const name of names) delete process.env[name];
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runphantom-provider-check-"));
  process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV] = path.join(root, "state", "secrets.json");
});

afterEach(() => {
  for (const [name, value] of original) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});

describe.serial("provider connection check", () => {
  test("reports a missing key without any network request", async () => {
    let calls = 0;
    const result = await checkProviderConnection("openai", { fetch: async () => { calls++; return json(200, {}); } });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ ok: false, failure: "missing_key", source: null, latencyMs: null, message: "No OpenAI key is saved or set in the environment." });
  });

  test("sends one GET to each provider's models list with the key in a header, never the URL", async () => {
    const seen: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method, headers: init.headers as Record<string, string> });
      if (url.includes("openai")) return json(200, { object: "list", data: [{ id: "gpt-5-nano" }, { id: "gpt-5-mini" }] });
      if (url.includes("anthropic")) return json(200, { data: [{ id: "claude-haiku-4-5-20251001" }], has_more: true });
      return json(200, { models: [{ name: "models/gemini-3.5-flash-lite" }, { name: "models/gemini-3.8-flash" }, { name: "x" }] });
    };
    setStoredSecret("openai", "sk-proj-stored-0001");
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-fix-0002";
    setStoredSecret("gemini", "AIza-stored-gemini-fixture-0003");

    const openai = await checkProviderConnection("openai", { fetch: fetcher });
    const anthropic = await checkProviderConnection("anthropic", { fetch: fetcher });
    const gemini = await checkProviderConnection("gemini", { fetch: fetcher });

    expect(seen.map(call => call.url)).toEqual([PROVIDER_MODELS_ENDPOINT.openai, PROVIDER_MODELS_ENDPOINT.anthropic, PROVIDER_MODELS_ENDPOINT.gemini]);
    expect(seen.every(call => call.method === "GET")).toBe(true);
    expect(seen[0]!.headers.Authorization).toBe("Bearer sk-proj-stored-0001");
    expect(seen[1]!.headers).toMatchObject({ "x-api-key": "sk-ant-env-fix-0002", "anthropic-version": "2023-06-01" });
    expect(seen[2]!.headers["x-goog-api-key"]).toBe("AIza-stored-gemini-fixture-0003");
    for (const call of seen) expect(call.url).not.toMatch(/fixture/);

    expect(openai).toMatchObject({ ok: true, source: "store", modelCount: 2, modelCountComplete: true, failure: null, message: "OpenAI accepted the key and listed 2 models." });
    expect(anthropic).toMatchObject({ ok: true, source: "env", modelCount: 1, modelCountComplete: false, message: "Anthropic accepted the key and listed 1+ models." });
    expect(gemini).toMatchObject({ ok: true, source: "store", modelCount: 3, modelCountComplete: true });
    expect(typeof openai.latencyMs).toBe("number");
  });

  test("checks the saved key when the environment also sets one, matching the key the app uses", async () => {
    const seen: string[] = [];
    setStoredSecret("openai", "sk-proj-saved-0005");
    process.env.OPENAI_API_KEY = "sk-proj-env-0006";
    const result = await checkProviderConnection("openai", { fetch: async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization!);
      return json(200, { object: "list", data: [] });
    } });
    expect(seen).toEqual(["Bearer sk-proj-saved-0005"]);
    expect(result).toMatchObject({ ok: true, source: "store" });
  });

  test("classifies a rejected key and strips the key from the provider's message", async () => {
    const key = "sk-proj-rejected-9999";
    setStoredSecret("openai", key);
    const result = await checkProviderConnection("openai", {
      fetch: async () => json(401, { error: { message: `Incorrect API key provided: ${key}`, type: "invalid_request_error", code: "invalid_api_key" } }),
    });
    expect(result).toMatchObject({ ok: false, failure: "auth", httpStatus: 401, modelCount: null });
    expect(result.message).toBe("OpenAI rejected this key (HTTP 401). Paste a new key to replace it.");
    expect(JSON.stringify(result)).not.toContain(key);
  });

  test("does not echo the provider's text for a rejected key, which can carry a masked key fragment", async () => {
    setStoredSecret("openai", "sk-proj-bogus-key-WXYZ");
    const result = await checkProviderConnection("openai", {
      fetch: async () => json(401, { error: { message: "Incorrect API key provided: zzBOGUSK********************WXYZ.", type: "invalid_request_error", code: "invalid_api_key" } }),
    });
    expect(result).toMatchObject({ ok: false, failure: "auth", providerMessage: null });
    expect(JSON.stringify(result)).not.toContain("WXYZ");
  });

  test("maps quota, rate limits, outages, timeouts and network failures to plain answers", async () => {
    setStoredSecret("gemini", "AIza-stored-gemini-fixture-0003");
    const quota = await checkProviderConnection("gemini", { fetch: async () => json(429, { error: { status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota" } }) });
    expect(quota.failure).toBe("quota");
    const limited = await checkProviderConnection("gemini", { fetch: async () => json(429, { error: { status: "RESOURCE_EXHAUSTED", message: "slow down", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProject" }] }] } }) });
    expect(limited.failure).toBe("rate_limit");
    const down = await checkProviderConnection("gemini", { fetch: async () => json(503, { error: { status: "UNAVAILABLE", message: "busy" } }) });
    expect(down.failure).toBe("overloaded");
    const odd = await checkProviderConnection("gemini", { fetch: async () => json(404, { error: { message: "not found" } }) });
    expect(odd).toMatchObject({ failure: "provider_error", httpStatus: 404 });
    const timeout = await checkProviderConnection("gemini", { fetch: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); } });
    expect(timeout).toMatchObject({ failure: "timeout", message: "Google Gemini did not answer within 10 seconds." });
    const offline = await checkProviderConnection("gemini", { fetch: async () => { throw new TypeError("fetch failed"); } });
    expect(offline.failure).toBe("network");
  });

  test("a 200 without a model list is still a working key, with the count unknown", async () => {
    setStoredSecret("anthropic", "sk-ant-stored-0004");
    const result = await checkProviderConnection("anthropic", { fetch: async () => new Response("not json", { status: 200 }) });
    expect(result).toMatchObject({ ok: true, modelCount: null, modelCountComplete: false, message: "Anthropic accepted the key." });
  });
});

describe("maskSecret", () => {
  test("keeps a known prefix and the last four characters only", () => {
    expect(maskSecret("sk-proj-abcdefgh1234")).toBe("sk-proj-…1234");
    expect(maskSecret("sk-ant-api03-abWXYZ")).toBe("sk-ant-…WXYZ");
    expect(maskSecret("AIzaSyA-abcdefghijklmnop-9876")).toBe("AIza…9876");
    expect(maskSecret("plain-provider-token-5555")).toBe("…5555");
  });

  test("short values reveal nothing", () => {
    expect(maskSecret("short-key")).toBe("••••");
    expect(maskSecret("  ")).toBe("••••");
  });
});
