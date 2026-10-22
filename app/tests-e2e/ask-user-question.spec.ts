import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { AskUserQuestionPrompt, PublicAskUserQuestion } from "../../src/claude-ask-user-question";
import { test, expect } from "./fixtures";

type HookPayload = {
  hook_event_name: "PreToolUse";
  tool_name: "AskUserQuestion";
  session_id: string;
  tool_use_id: string;
  tool_input: { questions: AskUserQuestionPrompt[]; fixture: string };
};

function observeDaemon(page: Page, origin: string) {
  const events = {
    providers: [] as string[],
    questions: [] as PublicAskUserQuestion[],
    resolved: [] as string[],
  };
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    if (url.host !== new URL(origin).host || url.pathname !== "/ws") return;
    socket.on("framereceived", ({ payload }) => {
      let message: { event?: string; data?: Record<string, unknown> };
      try { message = JSON.parse(payload.toString()); } catch { return; }
      if (!message?.data || typeof message.data !== "object") return;
      if (message.event === "agent_provider" && typeof message.data.provider === "string") {
        events.providers.push(message.data.provider);
      } else if (message.event === "claude_ask_user_question" && typeof message.data.id === "string") {
        events.questions.push(message.data as unknown as PublicAskUserQuestion);
      } else if (message.event === "claude_ask_user_question_resolved" && typeof message.data.id === "string") {
        events.resolved.push(message.data.id);
      }
    });
  });
  return events;
}

function recordUnexpectedMutations(page: Page, mutations: string[]) {
  page.on("request", request => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
    const pathname = new URL(request.url()).pathname;
    if (!/^\/api\/claude\/ask-user-question\/[^/]+\/answer$/.test(pathname)) {
      mutations.push(`${request.method()} ${pathname}`);
    }
  });
}

// This is the local hook caller, not a Claude process: it waits on the real
// daemon HTTP request until a browser supplies the answer.
function startHook(origin: string, payload: HookPayload) {
  const controller = new AbortController();
  let settled = false;
  const result = fetch(`${origin}/api/claude/ask-user-question/hook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).then(async response => ({ status: response.status, body: await response.json() as unknown }))
    .catch(error => ({ error: String(error) }))
    .finally(() => { settled = true; });
  return { result, get settled() { return settled; }, abort: () => controller.abort() };
}

test("a real local question waits for a keyboard answer and resolves in every pane", async ({ page, context, request, runPhantom }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const events = observeDaemon(page, runPhantom.url);
  const unexpectedMutations: string[] = [];
  recordUnexpectedMutations(page, unexpectedMutations);
  const payload: HookPayload = {
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    session_id: "local-question-session",
    tool_use_id: "local-question-tool",
    tool_input: {
      fixture: "synthetic-only",
      questions: [
        { question: "Which task first?", header: "Priority", multiSelect: false, options: [
          { label: "Fix tests", description: "Repair the local tests." },
          { label: "Inspect logs", description: "Read synthetic diagnostics." },
        ] },
        { question: "Which platforms?", header: "Coverage", multiSelect: true, options: [
          { label: "Windows", description: "Check local Windows behavior." },
          { label: "macOS", description: "Check local macOS behavior." },
        ] },
      ],
    },
  };
  const answers = { "Which task first?": "Fix tests", "Which platforms?": "Windows" };
  let hook: ReturnType<typeof startHook> | undefined;
  let observer: Page | undefined;
  let questionId: string | undefined;

  try {
    await page.goto(runPhantom.url);
    await expect.poll(() => events.providers).toContain("claude");
    await expect(page.getByRole("button", { name: "Ask Claude Code", exact: true })).toBeVisible();
    expect((await request.post(`${runPhantom.url}/api/claude/ask-user-question/hook`, {
      data: { ...payload, tool_input: { questions: [] } },
    })).status()).toBe(400);

    hook = startHook(runPhantom.url, payload);
    await expect.poll(() => events.questions.length).toBe(1);
    const question = events.questions[0]!;
    questionId = question.id;
    expect(questionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(question).toMatchObject({ session_id: payload.session_id, tool_use_id: payload.tool_use_id,
      questions: payload.tool_input.questions });
    const answerUrl = `${runPhantom.url}/api/claude/ask-user-question/${encodeURIComponent(questionId)}/answer`;
    const pane = page.getByRole("complementary", { name: "Coding-agent debug chat" });
    const log = pane.getByRole("log", { name: "Debug chat messages" });
    const heading = log.getByText("Claude needs input", { exact: true });
    await expect(pane).toBeVisible();
    await expect(heading).toHaveCount(1);
    await expect(heading).toBeVisible();
    const priority = log.getByRole("group", { name: "Which task first?", exact: true });
    const coverage = log.getByRole("group", { name: "Which platforms?", exact: true });
    const fixTests = priority.getByRole("radio", { name: /^Fix tests\b/ });
    const inspectLogs = priority.getByRole("radio", { name: /^Inspect logs\b/ });
    const windows = coverage.getByRole("checkbox", { name: /^Windows\b/ });
    const macOS = coverage.getByRole("checkbox", { name: /^macOS\b/ });
    const sendAnswer = log.getByRole("button", { name: "Send answer", exact: true });
    await expect(priority.getByText("Priority", { exact: true })).toBeVisible();
    await expect(coverage.getByText("Coverage", { exact: true })).toBeVisible();
    await expect(priority.getByText("Repair the local tests.", { exact: true })).toBeVisible();
    await expect(coverage.getByText("Check local Windows behavior.", { exact: true })).toBeVisible();
    for (const option of [fixTests, inspectLogs, windows, macOS]) {
      await expect(option).toBeVisible();
      await expect(option).toHaveAttribute("aria-checked", "false");
    }
    await expect(sendAnswer).toBeDisabled();
    expect(hook.settled).toBe(false);
    await pane.screenshot({ path: testInfo.outputPath("ask-user-question-options.png") });

    // A newly connected real page receives the pending question, then observes
    // resolution without submitting an answer or updating its own local state.
    observer = await context.newPage();
    await observer.setViewportSize({ width: 1440, height: 1000 });
    await observer.route("**/*", async route => {
      const url = new URL(route.request().url());
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (local || ["about:", "blob:", "data:"].includes(url.protocol)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    recordUnexpectedMutations(observer, unexpectedMutations);
    const observerEvents = observeDaemon(observer, runPhantom.url);
    await observer.goto(runPhantom.url);
    await expect.poll(() => observerEvents.providers).toContain("claude");
    await expect.poll(() => observerEvents.questions.map(item => item.id)).toEqual([questionId]);
    const observerLog = observer.getByRole("complementary", { name: "Coding-agent debug chat" })
      .getByRole("log", { name: "Debug chat messages" });
    await expect(observerLog.getByText("Claude needs input", { exact: true })).toBeVisible();

    expect((await request.post(answerUrl, { data: { answers: {} } })).status()).toBe(400);
    expect((await request.post(`${runPhantom.url}/api/claude/ask-user-question/${randomUUID()}/answer`, {
      data: { answers },
    })).status()).toBe(404);
    expect((await request.post(answerUrl, {
      headers: { Origin: "http://127.0.0.1:1" }, data: { answers },
    })).status()).toBe(403);
    await expect(heading).toBeVisible();
    await expect(observerLog.getByText("Claude needs input", { exact: true })).toBeVisible();
    expect(hook.settled).toBe(false);
    expect(events.resolved).toEqual([]);

    await inspectLogs.focus();
    await inspectLogs.press("Space");
    await expect(inspectLogs).toHaveAttribute("aria-checked", "true");
    await expect(sendAnswer).toBeDisabled();
    await fixTests.focus();
    await fixTests.press("Space");
    await expect(fixTests).toHaveAttribute("aria-checked", "true");
    await expect(inspectLogs).toHaveAttribute("aria-checked", "false");
    await windows.focus();
    await windows.press("Space");
    await macOS.focus();
    await macOS.press("Space");
    await expect(windows).toHaveAttribute("aria-checked", "true");
    await expect(macOS).toHaveAttribute("aria-checked", "true");
    await macOS.press("Space");
    await expect(windows).toHaveAttribute("aria-checked", "true");
    await expect(macOS).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Tab");
    await expect(coverage.getByRole("textbox", { name: "Other answer for Which platforms?", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(sendAnswer).toBeFocused();
    await expect(sendAnswer).toBeEnabled();

    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === answerUrl && response.request().method() === "POST"),
      page.keyboard.press("Enter"),
    ]);
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ answers });
    expect(await response.json()).toEqual({ ok: true });
    await expect.poll(() => hook!.settled).toBe(true);
    expect(await hook.result).toEqual({ status: 200, body: { hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...payload.tool_input, answers },
    } } });
    await expect.poll(() => events.resolved).toEqual([questionId]);
    await expect.poll(() => observerEvents.resolved).toEqual([questionId]);
    await expect(heading).toHaveCount(0);
    await expect(priority).toHaveCount(0);
    await expect(coverage).toHaveCount(0);
    await expect(observerLog.getByText("Claude needs input", { exact: true })).toHaveCount(0);
    await expect(observerLog.getByRole("group")).toHaveCount(0);
    expect((await request.post(answerUrl, { data: { answers } })).status()).toBe(404);
    expect(unexpectedMutations).toEqual([]);
    await expect(pane.getByRole("combobox", { name: "Ask Claude Code", exact: true })).toBeVisible();
    await pane.screenshot({ path: testInfo.outputPath("ask-user-question-answered.png") });
  } finally {
    const pendingId = questionId ?? events.questions.find(item => item.session_id === payload.session_id)?.id;
    try {
      if (hook && pendingId && !events.resolved.includes(pendingId)) {
        await request.post(`${runPhantom.url}/api/claude/ask-user-question/${encodeURIComponent(pendingId)}/answer`, {
          data: { answers: { "Which task first?": "Fixture cleanup", "Which platforms?": "Fixture cleanup" } },
          timeout: 5000,
        });
      }
    } finally {
      hook?.abort();
      await hook?.result;
      await observer?.close();
    }
  }
});
