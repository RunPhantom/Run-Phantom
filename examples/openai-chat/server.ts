import express from "express";
import OpenAI from "openai";
import { loadWorkspaceEnv } from "../loadEnv";
import { ExampleTrace, page } from "../shared/runphantom";

loadWorkspaceEnv(import.meta.url);

const port = Number(process.env.PORT || 3012);
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const app = express();

app.use(express.json({ limit: "64kb" }));
app.get("/", (_request, response) => {
  response.type("html").send(page(
    "Run Phantom · OpenAI",
    "A provider-direct OpenAI request exported to Run Phantom as vendor-neutral OTLP/HTTP.",
  ));
});

app.post("/api/chat", async (request, response) => {
  const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
  if (!message) {
    response.status(400).json({ error: "message is required" });
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    response.status(503).json({ error: "OPENAI_API_KEY is not configured" });
    return;
  }

  const messages = [{ role: "user" as const, content: message }];
  const trace = new ExampleTrace("openai-chat", messages);
  const startedAtMs = Date.now();

  try {
    const completion = await new OpenAI().chat.completions.create({ model, messages });
    const output = completion.choices[0]?.message ?? { role: "assistant", content: "" };
    const text = typeof output.content === "string" ? output.content : "";
    trace.addLlm({
      name: "openai.chat.completions",
      provider: "openai",
      model: completion.model || model,
      input: messages,
      output: [output],
      startedAtMs,
      inputTokens: completion.usage?.prompt_tokens,
      outputTokens: completion.usage?.completion_tokens,
    });
    await trace.finish(output);
    response.json({ text, runUrl: trace.runUrl() });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    trace.addLlm({
      name: "openai.chat.completions",
      provider: "openai",
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
  console.log(`Run Phantom OpenAI example: http://localhost:${port}`);
});
