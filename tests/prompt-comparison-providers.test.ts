import { test, expect } from "bun:test";
import { createComparisonProviderClient } from "../src/prompts/providers";

const options = { maxOutputTokens: 128, temperature: 0 };
const target = { provider: "openai", model: "gpt-4.1-mini" } as const;

test("native controlled HTTP receives exact literal request once and returns measured usage without billing claims", async () => {
  let calls = 0, received: unknown;
  const server = Bun.serve({ port: 0, fetch: async req => { calls++; received = await req.json(); return Response.json({ model: "gpt-4.1-mini", choices: [{ message: { content: "$& $$ {{nested}} <img>" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }); } });
  try {
    const urls: string[] = [];
    const client = createComparisonProviderClient({ credentials: { openai: "fixture-token" }, transport: (url, init) => { urls.push(String(url)); return fetch(server.url, init); }, provenance: "controlled-http-fixture" });
    const result = await client.execute({ target, compiled: "Literal {{name}} $&", options, signal: new AbortController().signal });
    expect(calls).toBe(1); expect(urls).toEqual(["https://api.openai.com/v1/chat/completions"]);
    expect(received).toMatchObject({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "Literal {{name}} $&" }], max_completion_tokens: 128, temperature: 0, stream: false });
    expect(result.output).toBe("$& $$ {{nested}} <img>"); expect(result.usage.inputTokens).toBe(7); expect(result.provenance).toBe("controlled-http-fixture");
  } finally { await server.stop(true); }
});

test("redirects, oversized streamed bodies, duplicate JSON and credential outputs refuse without retries or echoed payload", async () => {
  for (const kind of ["redirect", "oversized", "duplicate", "credential"]) {
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: () => {
      calls++;
      if (kind === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.invalid/capture" } });
      if (kind === "oversized") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65536)); controller.enqueue(new Uint8Array(1)); controller.close(); } }));
      if (kind === "duplicate") return new Response('{"model":"gpt-4.1-mini","model":"other"}');
      return Response.json({ model: "gpt-4.1-mini", choices: [{ message: { content: "password=hunter2" }, finish_reason: "stop" }] });
    } });
    try {
      const client = createComparisonProviderClient({ credentials: { openai: "fixture-token" }, transport: (_url, init) => fetch(server.url, init), provenance: "controlled-http-fixture" });
      let failure: unknown;
      try { await client.execute({ target, compiled: "small", options, signal: new AbortController().signal }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain("hunter2"); expect(calls).toBe(1);
    } finally { await server.stop(true); }
  }
});

test("missing credentials sends no request and native cancellation aborts held response", async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response(new ReadableStream({ start() {} })); } });
  try {
    const transport = (_url: string | URL, init: RequestInit) => fetch(server.url, init);
    const unavailable = createComparisonProviderClient({ credentials: {}, transport, provenance: "controlled-http-fixture" });
    await unavailable.execute({ target, compiled: "small", options, signal: new AbortController().signal }).then(() => { throw new Error("Unexpected provider request"); }, failure => expect(failure).toBeInstanceOf(Error)); expect(calls).toBe(0);
    const controller = new AbortController(), client = createComparisonProviderClient({ credentials: { openai: "fixture-token" }, transport, provenance: "controlled-http-fixture" });
    const pending = client.execute({ target, compiled: "small", options, signal: controller.signal });
    while (!calls) await Bun.sleep(5);
    controller.abort(); await pending.then(() => { throw new Error("Unexpected completed provider request"); }, failure => expect(failure).toBeInstanceOf(Error)); expect(calls).toBe(1);
  } finally { await server.stop(true); }
});

test("native Anthropic request uses its closed message API and preserves uncached/cache category observations", async () => {
  let headers: Headers | undefined, request: unknown;
  const server = Bun.serve({ port: 0, fetch: async req => { headers = req.headers; request = await req.json(); return Response.json({ model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Literal answer" }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 6, cache_creation_input_tokens: 0 } }); } });
  try {
    const urls: string[] = [], client = createComparisonProviderClient({ credentials: { anthropic: "fixture-token" }, transport: (url, init) => { urls.push(String(url)); return fetch(server.url, init); }, provenance: "controlled-http-fixture" });
    const result = await client.execute({ target: { provider: "anthropic", model: "claude-haiku-4-5-20251001" }, compiled: "{{literal}}", options, signal: new AbortController().signal });
    expect(urls).toEqual(["https://api.anthropic.com/v1/messages"]); expect(headers?.get("anthropic-version")).toBe("2023-06-01");
    expect(request).toMatchObject({ messages: [{ role: "user", content: "{{literal}}" }], max_tokens: 128, stream: false });
    expect(result.usage).toMatchObject({ inputTokens: 9, cacheReadTokens: 6, cacheWriteTokens: 0, outputTokens: 3 }); expect(result.output).toBe("Literal answer");
  } finally { await server.stop(true); }
});

test("an owned deadline aborts a real held HTTP response and retains uncertain-send classification", async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response(new ReadableStream({ start() {} })); } });
  try {
    const client = createComparisonProviderClient({ credentials: { openai: "fixture-token" }, transport: (_url, init) => fetch(server.url, init), provenance: "controlled-http-fixture" });
    let failure: unknown;
    try { await client.execute({ target, compiled: "bounded", options, signal: new AbortController().signal, remainingMs: 25 }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "timeout", requestMayHaveBeenSent: true }); expect(calls).toBe(1);
  } finally { await server.stop(true); }
});
