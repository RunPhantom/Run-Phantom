import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { loadWorkspaceEnv } from "../loadEnv";
import { ExampleTrace, page } from "../shared/runphantom";

loadWorkspaceEnv(import.meta.url);

const port = Number(process.env.PORT || 3013);
const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const app = express();

app.use(express.json({ limit: "64kb" }));
app.get("/", (_request, response) => {
  response.type("html").send(page(
    "Run Phantom · Anthropic",
    "A provider-direct Anthropic request exported to Run Phantom as vendor-neutral OTLP/HTTP.",
  ));
});

app.post("/api/chat", async (request, response) => {
  const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
  if (!message) {
    response.status(400).json({ error: "message is required" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    response.status(503).json({ error: "ANTHROPIC_API_KEY is not configured" });
    return;
  }

  const messages = [{ role: "user" as const, content: message }];
  const trace = new ExampleTrace("anthropic-chat", messages);
  const startedAtMs = Date.now();

  try {
    const result = await new Anthropic().messages.create({ model, max_tokens: 1024, messages });
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    trace.addLlm({
      name: "anthropic.messages.create",
      provider: "anthropic",
      model: result.model || model,
      input: messages,
      output: result.content,
      startedAtMs,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    });
    await trace.finish(result.content);
    response.json({ text, runUrl: trace.runUrl() });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    trace.addLlm({
      name: "anthropic.messages.create",
      provider: "anthropic",
      model,
      input: messages,
      output: { error: detail },
      startedAtMs,
      error: detail,
    });
    try { await trace.finish({ error: detail }, detail); } catch {}
    response.status(500).json({ error: detail, runUrl: trace.runUrl() });
  }
});

app.listen(port, () => {
  console.log(`Run Phantom Anthropic example: http://localhost:${port}`);
});
