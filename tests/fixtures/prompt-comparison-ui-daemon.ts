import { once } from "node:events";
import { createServer } from "../../src/server";
import { createTeamServer } from "../../src/team/server";
import { loadTeamConfig } from "../../src/team/config";
import { createComparisonProviderClient } from "../../src/prompts/providers";
import { closeDb } from "../../src/db";

const mode = process.argv[2]; if (mode !== "local" && mode !== "team") throw new Error("Closed native fixture mode required");
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { model: string; messages: { content: string }[]; temperature?: number; thinking?: { type: string } };
  // Mirror the provider 400s observed for these models so the UI path proves the request shape it sends.
  if (["gpt-6.1-terra", "claude-sonnet-5-5"].includes(body.model) && body.temperature !== undefined || body.model === "claude-sonnet-5-5" && body.thinking?.type !== "between_tools") return Response.json({ error: { type: "invalid_request_error" } }, { status: 400 });
  const held = body.messages[0].content.includes("[hold]"), overage = body.messages[0].content.includes("[overage]"), cut = body.messages[0].content.includes("[length]");
  if (body.messages[0].content.includes("[reasoning-limit]") && body.model === "gpt-6.1-terra") return Response.json({ model: body.model, service_tier: "default", choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 29, completion_tokens: 16, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 16 } } });
  if (held) await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
  const output = overage ? "x".repeat(7900) : `Controlled ${body.model} answer.\n${body.messages[0].content}`, raw = body.model.startsWith("gpt")
    ? { model: body.model, service_tier: "default", choices: [{ message: { content: output }, finish_reason: cut ? "length" : "stop" }], usage: { prompt_tokens: overage ? 1000000 : 3, completion_tokens: overage ? 1 : 2, prompt_tokens_details: { cached_tokens: 0 } } }
    : { model: body.model, stop_reason: cut ? "max_tokens" : "end_turn", content: [{ type: "text", text: output }], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: "global", service_tier: "standard" } };
  return Response.json(raw);
} });
const client = createComparisonProviderClient({ credentials: { openai: "fixture-token", anthropic: "fixture-token" }, transport: (_url, init) => fetch(upstream.url, init), provenance: "controlled-http-fixture" });
const options = { comparisons: { client, budgets: { openai: 1000000, anthropic: 1000000 } } };
const handle = mode === "team" ? await createTeamServer(loadTeamConfig(), options) : await createServer(Number(process.env.RUNPHANTOM_PORT), options);
const port = mode === "team" ? Number(process.env.RUNPHANTOM_TEAM_PORT) : Number(process.env.RUNPHANTOM_PORT);
handle.server.listen(port, "127.0.0.1"); await once(handle.server, "listening");
console.log(JSON.stringify({ ready: true, mode, url: `http://127.0.0.1:${port}`, pid: process.pid, provenance: "controlled-http-fixture", providerCalls: 0 }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  if ("close" in handle) await handle.close(); else await new Promise<void>((resolve, reject) => handle.server.close((error?: Error) => error ? reject(error) : resolve()));
  await upstream.stop(true); closeDb(); process.exit(0);
}
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
