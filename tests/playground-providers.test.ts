import { describe, expect, test } from "bun:test";
import { readSse, ResponseLimitError } from "../src/playground/sse";
import { classifyHttpError, sanitizeProviderMessage } from "../src/playground/providers";
import { parsePlaygroundRunRequest } from "../src/playground/protocol";

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}

async function collect(stream: ReadableStream<Uint8Array>, max = 1024 * 1024) {
  const out: Array<{ event: string | null; data: string }> = [];
  for await (const event of readSse(stream, max)) out.push(event);
  return out;
}

describe("event-stream parser", () => {
  test("handles CRLF split across chunks, comments, multi-line data and a final event without a blank line", async () => {
    expect(await collect(body(["event: a\r", "\ndata: 1\r\n\r\n: keep-alive\n\ndata: x\ndata: y\n\n", "data:no-space"]))).toEqual([
      { event: "a", data: "1" }, { event: null, data: "x\ny" }, { event: null, data: "no-space" },
    ]);
  });

  test("refuses to buffer an unbounded response", async () => {
    const failure = await collect(body(["data: " + "x".repeat(100) + "\n\n"]), 50).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ResponseLimitError);
  });
});

describe("provider error classification", () => {
  test("separates auth, quota, rate limit, model, overload and request errors", () => {
    expect(classifyHttpError("openai", 401, "{}").kind).toBe("auth");
    expect(classifyHttpError("gemini", 403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "denied" } })).kind).toBe("auth");
    expect(classifyHttpError("openai", 429, JSON.stringify({ error: { code: "insufficient_quota", message: "quota" } })).kind).toBe("quota");
    expect(classifyHttpError("openai", 429, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit reached" } })).kind).toBe("rate_limit");
    expect(classifyHttpError("openai", 400, JSON.stringify({ error: { message: "The model `gpt-x` does not exist" } })).kind).toBe("invalid_model");
    expect(classifyHttpError("anthropic", 503, "upstream unavailable")).toEqual({ kind: "overloaded", providerMessage: "upstream unavailable" });
    expect(classifyHttpError("anthropic", 500, "").kind).toBe("provider_error");
    expect(classifyHttpError("gemini", 400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload" } })).kind).toBe("invalid_request");
    expect(classifyHttpError("gemini", 504, "").kind).toBe("timeout");
  });

  test("never keeps a key, key-shaped text or control characters in a provider message", () => {
    expect(sanitizeProviderMessage("bad key my-custom-secret\u0007 and sk-proj-abcdefghijklmnop and AIzaSyA1234567890123456789012", "my-custom-secret"))
      .toBe("bad key [REDACTED]  and [REDACTED] and [REDACTED]");
    expect(sanitizeProviderMessage("x".repeat(1000), null)!.length).toBe(600);
  });
});

describe("request validation", () => {
  test("accepts the shorthand single target and fills defaults", () => {
    expect(parsePlaygroundRunRequest({ provider: "gemini", model: "gemini-2.5-flash-lite", messages: [{ role: "user", content: "hi" }] })).toEqual({
      targets: [{ provider: "gemini", model: "gemini-2.5-flash-lite" }], system: "", messages: [{ role: "user", content: "hi" }], tools: [], stream: false, source: null,
      params: { maxOutputTokens: 1024 },
    });
  });

  test("rejects a tool answer that names a different tool than the call it answers", () => {
    expect(() => parsePlaygroundRunRequest({ provider: "openai", model: "gpt-5-nano", messages: [
      { role: "user", content: "x" }, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "a" }] }, { role: "tool", toolCallId: "c1", name: "b", content: "r" },
    ] })).toThrow("names tool");
  });
});
