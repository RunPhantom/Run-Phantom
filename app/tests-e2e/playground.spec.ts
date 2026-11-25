import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { PlaygroundCallResult } from "../../src/playground/protocol";

const DRAFT_KEY = "runphantom:playground:draft";

// The app maps "mod" from the browser's reported platform, which the Playwright device profile may override.
async function modKey(page: Page): Promise<"Meta" | "Control"> {
  return await page.evaluate(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
    return /mac|iphone|ipad|ipod/i.test(platform);
  }) ? "Meta" : "Control";
}

function callResult(overrides: Partial<PlaygroundCallResult> & Pick<PlaygroundCallResult, "index" | "provider" | "model">): PlaygroundCallResult {
  return {
    status: "ok", output: { text: "", toolCalls: [] }, finishReason: "stop", providerFinishReason: "stop", responseModel: overrides.model, responseId: "resp_1",
    usage: { inputTokens: 24, outputTokens: 40, cachedInputTokens: 0, cacheWriteInputTokens: null, reasoningTokens: 0, totalTokens: 64 },
    latencyMs: 1200, timeToFirstTokenMs: 400, warnings: [], error: null, runId: `${String(overrides.index).repeat(8)}aaaaaaaabbbbbbbbcccccccc`, spanId: "1234567890abcdef",
    ...overrides,
  };
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** Stands in for the provider calls: the daemon's real /api/playground/runs would need live keys. */
async function mockRuns(page: Page, respond: (body: Record<string, unknown>) => { status?: number; contentType?: string; body: string }) {
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/playground/runs", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    const reply = respond(body);
    await route.fulfill({ status: reply.status ?? 200, contentType: reply.contentType ?? "text/event-stream; charset=utf-8", body: reply.body });
  });
  return requests;
}

async function openPlayground(page: Page, url: string, draft?: Record<string, unknown>) {
  await page.goto(`${url}/runs`);
  await page.evaluate(([key, value]) => { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); }, [DRAFT_KEY, draft ? JSON.stringify(draft) : ""] as const);
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await expect(page).toHaveURL(/\/playground$/);
  await expect(page.getByRole("heading", { name: "Playground", level: 1 })).toBeVisible();
}

const baseDraft = { version: 1, system: "", temperature: "", maxOutputTokens: "256", reasoningEffort: "", toolsEnabled: false, toolsText: "[]", openedFrom: null };

test("the editor builds a prompt, validates it and keeps the draft", async ({ page, runPhantom }) => {
  const requests = await mockRuns(page, () => ({ body: sse([["start", { comparisonId: "c", targets: [] }], ["done", { comparisonId: "c" }]]) }));
  await openPlayground(page, runPhantom.url);

  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("openai/gpt-5-nano");
  await expect(page.getByText("No key saved")).toBeVisible();
  await expect(page.locator("#playground-model-0-key").getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", "/settings");
  await expect(model).toHaveAttribute("aria-describedby", "playground-model-0-key");
  await expect(model.locator("optgroup").first()).toHaveAttribute("label", "OpenAI · no key");

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator("[data-playground-problem]")).toHaveText("Message 1 is empty. Write a user message or remove it.");
  expect(requests).toHaveLength(0);

  await page.getByLabel("System").fill("Answer briefly.");
  await page.getByRole("textbox", { name: "Content of message 1" }).fill("First question");
  await page.getByRole("button", { name: "Add message" }).click();
  await expect(page.getByRole("combobox", { name: "Role for message 2" })).toHaveValue("assistant");
  await page.getByRole("textbox", { name: "Content of message 2" }).fill("An answer");
  await page.getByRole("button", { name: "Add message" }).click();
  await page.getByRole("textbox", { name: "Content of message 3" }).fill("Follow-up");
  await page.getByRole("button", { name: "Move message 3 up" }).click();
  await expect(page.getByRole("textbox", { name: "Content of message 2" })).toHaveValue("Follow-up");
  await page.getByRole("button", { name: "Move message 2 down" }).click();
  await page.getByRole("button", { name: "Remove message 2" }).click();
  await expect(page.getByText("2 messages")).toBeVisible();

  await page.getByLabel("Temperature").fill("4");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator("[data-playground-problem]")).toContainText("Temperature must be a number from 0 to 2");
  await expect(page.getByLabel("Temperature")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Temperature").fill("");

  await page.getByLabel("Send tool definitions").check();
  const tools = page.getByRole("textbox", { name: "Tool definitions (JSON)" });
  await expect(page.getByText(/^1 tool: get_weather\./)).toBeVisible();
  await tools.fill('[{"name": "fs.read"}]');
  await expect(tools).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Tool 1 needs a name that starts with a letter or underscore")).toBeVisible();
  await tools.fill('[{"name": "lookup_order", "parameters": {"type": "object", "properties": {"id": {"type": "string"}}}}]');
  await expect(page.getByText(/^1 tool: lookup_order\./)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("System")).toHaveValue("Answer briefly.");
  await expect(page.getByRole("textbox", { name: "Content of message 2" })).toHaveValue("Follow-up");
  await expect(page.getByRole("combobox", { name: "Role for message 2" })).toHaveValue("user");
  await expect(page.getByRole("textbox", { name: "Tool definitions (JSON)" })).toHaveValue(/lookup_order/);

  await page.getByRole("textbox", { name: "Content of message 2" }).fill("Another question");
  await page.getByRole("textbox", { name: "Content of message 1" }).press(`${await modKey(page)}+Enter`);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({
    targets: [{ provider: "openai", model: "gpt-5-nano" }], system: "Answer briefly.", stream: true,
    messages: [{ role: "user", content: "First question" }, { role: "user", content: "Another question" }],
    params: { maxOutputTokens: 1024 },
    tools: [{ name: "lookup_order", parameters: { type: "object", properties: { id: { type: "string" } } } }],
  });
});

test("compare runs stream into side-by-side columns with metrics, run links and a word diff", async ({ page, runPhantom }) => {
  const requests = await mockRuns(page, body => {
    const targets = body.targets as Array<{ provider: "openai" | "anthropic" | "gemini"; model: string }>;
    return {
      body: sse([
        ["start", { comparisonId: "cmp-1", targets: targets.map((target, index) => ({ index, ...target })) }],
        ["delta", { index: 1, text: "Tracing records each " }],
        ["delta", { index: 0, text: "Tracing shows each " }],
        ["delta", { index: 1, text: "tool call." }],
        ["result", callResult({ index: 1, provider: "anthropic", model: "claude-haiku-4-5-20251001", output: { text: "Tracing records each tool call.", toolCalls: [] }, usage: { inputTokens: 21, outputTokens: 34, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: null, totalTokens: 55 }, latencyMs: 1000, timeToFirstTokenMs: 684 })],
        ["delta", { index: 0, text: "step." }],
        ["result", callResult({ index: 0, provider: "openai", model: "gpt-5-nano", responseModel: "gpt-5-nano-2025-08-07", output: { text: "Tracing shows each step.", toolCalls: [] } })],
        ["done", { comparisonId: "cmp-1" }],
      ]),
    };
  });
  await openPlayground(page, runPhantom.url, { ...baseDraft, messages: [{ id: "a", role: "user", content: "Why trace agents?" }], targets: [{ provider: "openai", model: "gpt-5-nano" }] });

  await page.getByRole("button", { name: "2 models", exact: true }).click();
  await expect(page.getByRole("button", { name: "2 models", exact: true })).toHaveAttribute("aria-pressed", "true");
  const second = page.getByRole("combobox", { name: "Model 2", exact: true });
  await second.selectOption("anthropic/claude-haiku-4-5-20251001");
  await expect(page.getByRole("button", { name: "Show differences" })).toBeDisabled();
  await page.getByRole("button", { name: "Run 2 models", exact: true }).click();

  const first = page.locator("[data-playground-column='0']"), other = page.locator("[data-playground-column='1']");
  await expect(first.getByRole("heading", { name: /GPT-5 nano/ })).toBeVisible();
  await expect(other.getByRole("heading", { name: /Claude Haiku 4\.5/ })).toBeVisible();
  await expect(first.locator("[data-playground-output]")).toHaveText("Tracing shows each step.");
  await expect(other.locator("[data-playground-output]")).toHaveText("Tracing records each tool call.");
  const metrics = other.locator("[data-playground-metrics]");
  await expect(metrics).toContainText("Finished");
  await expect(metrics).toContainText("1.0s");
  await expect(metrics).toContainText("684ms");
  await expect(metrics).toContainText("21 in · 34 out");
  await expect(metrics).toContainText("$0.00019");
  await expect(first.locator("[data-playground-metrics]")).toContainText("gpt-5-nano-2025-08-07");
  await expect(first.getByRole("link", { name: /^Open run 00000000/ })).toHaveAttribute("href", "/runs/00000000aaaaaaaabbbbbbbbcccccccc/span/1234567890abcdef");
  await expect(page.getByRole("status").filter({ hasText: "Finished. All 2 models answered." })).toBeAttached();
  expect(requests[0]!.targets).toEqual([{ provider: "openai", model: "gpt-5-nano" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }]);

  await page.getByRole("button", { name: "Show differences" }).click();
  const diff = other.locator("[data-playground-diff]");
  await expect(diff.locator("del")).toHaveText(["shows", "step."]);
  await expect(diff.locator("ins")).toHaveText(["records", "tool call."]);
  await expect(other).toContainText("+3 −2 words vs. column 1");
  await expect(first.locator("[data-playground-diff]")).toHaveCount(0);

  await page.getByRole("button", { name: "Raw", exact: true }).click();
  await page.getByRole("button", { name: "Show differences" }).click();
  await expect(other.locator("[data-playground-output]")).toHaveText("Tracing records each tool call.");

  await page.getByRole("button", { name: "Remove model 2" }).click();
  await expect(page.getByRole("button", { name: "1 model", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-playground-column]")).toHaveCount(1);
});

test("provider failures read as plain errors with the next step", async ({ page, runPhantom }) => {
  let reply: "errors" | "busy" = "errors";
  await mockRuns(page, () => reply === "busy"
    ? { status: 429, contentType: "application/json", body: JSON.stringify({ error: "The Playground is already running 6 model calls. Wait for them to finish, then try again." }) }
    : {
      body: sse([
        ["start", { comparisonId: "e", targets: [] }],
        ["result", callResult({ index: 0, provider: "openai", model: "gpt-5-nano", status: "error", finishReason: "error", output: { text: "", toolCalls: [] }, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, totalTokens: null }, timeToFirstTokenMs: null, error: { kind: "auth", message: "OpenAI rejected the API key.", providerMessage: "Incorrect API key provided: sk-…", httpStatus: 401, retryable: false } })],
        ["result", callResult({ index: 1, provider: "anthropic", model: "claude-haiku-4-5-20251001", status: "error", finishReason: "error", output: { text: "", toolCalls: [] }, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, totalTokens: null }, error: { kind: "rate_limit", message: "Anthropic is rate limiting this key.", providerMessage: null, httpStatus: 429, retryable: true } })],
        ["result", callResult({ index: 2, provider: "gemini", model: "gemini-2.5-flash", status: "error", finishReason: "error", output: { text: "", toolCalls: [] }, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, totalTokens: null }, runId: null, spanId: null, error: { kind: "invalid_model", message: "Google Gemini does not offer gemini-2.5-flash to this API key.", providerMessage: "This model models/gemini-2.5-flash is no longer available to new users.", httpStatus: 404, retryable: false } })],
        ["done", { comparisonId: "e" }],
      ]),
    });
  await openPlayground(page, runPhantom.url, {
    ...baseDraft, messages: [{ id: "a", role: "user", content: "Hello" }],
    targets: [{ provider: "openai", model: "gpt-5-nano" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }, { provider: "gemini", model: "gemini-2.5-flash" }],
  });
  await page.getByRole("button", { name: "Run 3 models", exact: true }).click();

  const auth = page.locator("[data-playground-error='auth']");
  await expect(auth).toContainText("Key rejected");
  await expect(auth).toContainText("OpenAI rejected the API key.");
  await expect(auth.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings");
  await auth.getByText("Provider message · HTTP 401").click();
  await expect(auth).toContainText("Incorrect API key provided");
  await expect(page.locator("[data-playground-error='rate_limit']")).toContainText("Rate limited");
  await expect(page.locator("[data-playground-error='rate_limit']")).toContainText("Wait a minute and run again.");
  await expect(page.locator("[data-playground-error='invalid_model']")).toContainText("Model not available");
  await expect(page.locator("[data-playground-column='2']")).toContainText("Not recorded: nothing was sent to the provider.");
  await expect(page.locator("[data-playground-column='0'] [data-playground-metrics]")).toContainText("Est. cost—");
  await expect(page.getByRole("status").filter({ hasText: "Finished. 0 succeeded, 3 failed." })).toBeAttached();

  reply = "busy";
  await page.getByRole("button", { name: "Run 3 models", exact: true }).click();
  await expect(page.locator("[data-playground-problem]")).toHaveText("The Playground is already running 6 model calls. Wait for them to finish, then try again.");
  await expect(page.locator("[data-playground-column='0']")).toContainText("No result was received.");
});

test("Open in Playground fills the editor from a captured model call", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await page.request.post(`${runPhantom.url}/api/demo-traces/replay`)).ok()).toBe(true);
  await expect.poll(async () => {
    const detail = await (await page.request.get(`${runPhantom.url}/api/runs/detail/demo_triage`)).json().catch(() => null) as { run?: { finished?: number }; spans?: Array<{ id: string }> } | null;
    return !!detail?.run?.finished && !!detail.spans?.some(span => span.id === "demo_triage_llm-2");
  }, { timeout: 30_000 }).toBe(true);
  const requests = await mockRuns(page, () => ({ body: sse([["start", { comparisonId: "o", targets: [] }], ["done", { comparisonId: "o" }]]) }));
  await page.goto(`${runPhantom.url}/runs/demo_triage/span/demo_triage_tool-1`);
  await expect(page.getByText("lookup_account").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Open in Playground" })).toHaveCount(0);

  await page.goto(`${runPhantom.url}/runs/demo_triage/span/demo_triage_llm-2`);
  const open = page.getByRole("button", { name: "Open in Playground" });
  await expect(open).toHaveAttribute("data-span-action", "playground:open-span", { timeout: 20_000 });
  await open.click();

  const banner = page.locator("[data-playground-opened-from]");
  await expect(banner).toContainText("Opened from Customer support triage › ai.generateText");
  await expect(banner).toContainText("claude-sonnet-4-5 is not available in the Playground, so claude-haiku-4-5-20251001 was selected instead.");
  await expect(banner.getByRole("link")).toHaveAttribute("href", "/runs/demo_triage/span/demo_triage_llm-2");
  await expect(page).toHaveURL(/\/playground$/);
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("anthropic/claude-haiku-4-5-20251001");
  await expect(page.getByLabel("System")).toHaveValue(/^You triage incoming support tickets\./);
  await expect(page.getByRole("textbox", { name: "Content of message 1" })).toHaveValue(/export keeps timing out/);
  await expect(page.getByText("3 messages")).toBeVisible();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]!.source).toEqual({ runId: "demo_triage", spanId: "demo_triage_llm-2" });

  await page.goto(`${runPhantom.url}/playground?span=demo_triage_tool-1&run=demo_triage`);
  await expect(page.getByRole("alert").filter({ hasText: "Could not open that step: Only model call spans can be opened in the Playground." })).toBeVisible();
});
