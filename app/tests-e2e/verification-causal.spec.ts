import { mkdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { test, expect, connectTarget, act, observe, assertRuntime } from "./verification-fixture";
import { REPO_ROOT_PATH } from "./fixtures";
import type { AppCommand, Predicate, RelativeTarget, VerificationReport } from "../../src/verification/protocol";

const stateTarget: RelativeTarget = { kind: "state", store: "checkout", path: "requests" };
const elementTarget: RelativeTarget = { kind: "element", selector: "#synchronous-result" };
const transition = (target: RelativeTarget, relation: "changed" | "increased" | "decreased" | "becomes", equals?: unknown): Predicate =>
  relation === "becomes" ? { kind: "relative", target, relation, equals } : { kind: "relative", target, relation };
const click = (selector: string, targets: RelativeTarget[] = [stateTarget]): AppCommand => ({ type: "causal-click", selector, targets });

test.describe("causal action verification through the real SDK", () => {
  test("saved clicks capture synchronous state and DOM transitions and retain their report", async ({ page, request, runPhantom, targetApp }) => {
    const session = await connectTarget(page, request, runPhantom, targetApp.origin);
    const saved = await request.post(`${runPhantom.url}/api/verification/flows`, { data: { name: "Synchronous state and DOM", origin: targetApp.origin,
      steps: [{ command: { type: "click", selector: "#increment" }, predicate: { kind: "allOf", predicates: [transition(stateTarget, "increased"), transition(elementTarget, "becomes", 1)] } }] } });
    expect(saved.ok()).toBe(true);
    const flow = await saved.json() as { id: string };
    const replay = await request.post(`${runPhantom.url}/api/verification/flows/${flow.id}/run`, { data: { sessionId: session.id } });
    expect(replay.ok()).toBe(true);
    const report = await replay.json() as VerificationReport;
    expect(report.status).toBe("pass");
    await expect(page.getByText("Synchronous result", { exact: true })).toBeVisible();
    expect(report.context?.checks[0].causal).toMatchObject({ source: "sdk-reported", attribution: "captured", readings: [
      { target: stateTarget, before: { value: 0 }, after: { value: 1 } }, { target: elementTarget, before: { value: 0 }, after: { value: 1 } },
    ] });
    const observed = await observe(request, runPhantom, session.id);
    const owned = observed.events.filter(event => event.actionId === report.context?.checks[0].causal?.actionId);
    expect(owned.filter(event => event.type === "action.reading").map(event => event.data.phase)).toEqual(["before", "before", "after", "after"]);
    expect(owned.some(event => event.type === "action.result" && event.data.source === "sdk-reported")).toBe(true);
    await request.delete(`${runPhantom.url}/api/verification/flows/${flow.id}`);
    const retained = await request.get(`${runPhantom.url}/api/verification/reports`);
    expect((await retained.json() as VerificationReport[]).find(entry => entry.id === report.id)?.context).toEqual(report.context);
  });

  test("the user configures, runs, replays and inspects transitions with keyboard and mobile controls", async ({ page, context, request, runPhantom, targetApp }, testInfo) => {
    const app = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", error => consoleErrors.push(error.message));
    try {
      await connectTarget(app, request, runPhantom, targetApp.origin);
      await page.goto(`${runPhantom.url}/verification`);
      await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
      await page.getByRole("combobox", { name: "Action", exact: true }).selectOption("click");
      await page.getByLabel(/^Action selector/).fill("#increment");
      await page.getByRole("combobox", { name: "Check type", exact: true }).selectOption("relative");
      await page.getByRole("combobox", { name: "Required change", exact: true }).selectOption("increased");
      await page.getByLabel("Registered store", { exact: true }).fill("checkout");
      await page.getByLabel(/^State path/).fill("requests");
      await page.getByLabel("Check name (optional)", { exact: true }).fill("Synchronous counter");
      const runAction = page.getByRole("button", { name: "Run action", exact: true });
      await runAction.focus(); await runAction.press("Enter");
      await expect(app.getByText("Synchronous result", { exact: true })).toBeVisible();
      await expect(page.getByText("Action completed. Check the expected outcome next.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Check outcome", exact: true }).click();
      const passed = page.getByRole("article", { name: "Synchronous counter: pass", exact: true });
      await expect(passed).toBeVisible();
      await expect(passed.getByLabel("Action transition readings")).toContainText("Before: 0 (complete)");
      await expect(passed.getByLabel("Action transition readings")).toContainText("After: 1 (complete)");
      await expect(passed.getByText(/SDK-reported action result/)).toBeVisible();
      await page.getByLabel("Include current action in step", { exact: true }).check();
      await page.getByRole("button", { name: "Add step to flow", exact: true }).click();
      await page.getByLabel("Flow name", { exact: true }).fill("Counter transition replay");
      await page.getByRole("button", { name: "Save flow", exact: true }).click();
      const replay = page.getByRole("button", { name: "Replay Counter transition replay", exact: true });
      await expect(replay).toBeVisible(); await replay.focus(); await replay.press("Enter");
      await expect(page.getByRole("article", { name: "Counter transition replay: pass", exact: true })).toBeVisible();
      const output = path.join(REPO_ROOT_PATH, "output", "playwright", "F18");
      mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, "causal-desktop.png"), fullPage: true });
      await testInfo.attach("causal-desktop", { path: path.join(output, "causal-desktop.png"), contentType: "image/png" });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("article", { name: "Counter transition replay: pass", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: path.join(output, "causal-mobile.png"), fullPage: true });
      await testInfo.attach("causal-mobile", { path: path.join(output, "causal-mobile.png"), contentType: "image/png" });
      expect(consoleErrors).toEqual([]);
    } finally { await app.close(); }
  });

  test("an already present result is inconclusive for the click and still passes a current DOM check", async ({ page, request, runPhantom, targetApp }) => {
    const session = await connectTarget(page, request, runPhantom, targetApp.origin);
    await act(request, runPhantom, session.id, { type: "click", selector: "#increment" });
    const since = await act(request, runPhantom, session.id, click("#noop", [elementTarget]));
    const already = await assertRuntime(request, runPhantom, session.id, transition(elementTarget, "becomes", 1), since, "Already present result");
    expect(already.status).toBe("inconclusive"); expect(already.reason).toContain("already held");
    expect(already.context?.checks[0].causal?.readings[0]).toMatchObject({ before: { value: 1 }, after: { value: 1 } });
    const current = await assertRuntime(request, runPhantom, session.id, { kind: "element", selector: elementTarget.selector, state: "present" }, since);
    expect(current.status).toBe("pass");
  });

  test("a later background transition cannot overwrite the synchronous post-action snapshot", async ({ page, request, runPhantom, targetApp }) => {
    const session = await connectTarget(page, request, runPhantom, targetApp.origin);
    const since = await act(request, runPhantom, session.id, click("#background"));
    await expect(page.getByText("Synchronous result", { exact: true })).toBeVisible();
    const background = await assertRuntime(request, runPhantom, session.id, transition(stateTarget, "becomes", 1), since);
    expect(background.status).toBe("fail");
    expect(background.context?.checks[0].causal?.readings[0]).toMatchObject({ before: { value: 0 }, after: { value: 0 } });
    const current = await assertRuntime(request, runPhantom, session.id, { kind: "state", store: "checkout", path: "requests", equals: 1 }, since);
    expect(current.status).toBe("pass");
  });

  test("an SDK without the negotiated capability refuses the click before application mutation", async ({ page, request, runPhantom, targetApp }) => {
    const session = await connectTarget(page, request, runPhantom, targetApp.origin, undefined, false);
    const action = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/command`, { data: click("#increment") });
    expect(action.ok()).toBe(true);
    expect(await action.json()).toMatchObject({ ok: false, error: expect.stringContaining("no action was executed") });
    await expect(page.getByText("Synchronous result", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.checkoutState.requests)).toBe(0);
    const observed = await observe(request, runPhantom, session.id);
    expect(observed.events.some(event => event.type === "action.boundary")).toBe(false);
    const saved = await request.post(`${runPhantom.url}/api/verification/flows`, { data: { name: "Capture unavailable", origin: targetApp.origin,
      steps: [{ command: { type: "click", selector: "#increment" }, predicate: transition(stateTarget, "changed") }] } });
    const flow = await saved.json() as { id: string };
    const replay = await request.post(`${runPhantom.url}/api/verification/flows/${flow.id}/run`, { data: { sessionId: session.id } });
    expect((await replay.json() as VerificationReport).status).toBe("inconclusive");
    await page.goto(`${runPhantom.url}/verification`);
    const report = page.getByRole("article", { name: "Capture unavailable: inconclusive", exact: true });
    await expect(report).toBeVisible(); await expect(report.getByLabel("Action transition readings")).toContainText("Before: unavailable");
    await expect(report).toContainText("no action was executed");
  });

  test("missing, privacy-redacted and mismatched scopes never borrow another captured reading", async ({ page, request, runPhantom, targetApp }) => {
    const session = await connectTarget(page, request, runPhantom, targetApp.origin);
    const missingTarget: RelativeTarget = { kind: "state", store: "notRegistered", path: "" };
    const missingCursor = await act(request, runPhantom, session.id, click("#increment", [missingTarget]));
    const missing = await assertRuntime(request, runPhantom, session.id, transition(missingTarget, "changed"), missingCursor);
    expect(missing.status).toBe("inconclusive");
    expect(missing.context?.checks[0].causal?.readings[0].before?.availability).toBe("unavailable");
    const healthy = await act(request, runPhantom, session.id, click("#increment"));
    const mismatched = await assertRuntime(request, runPhantom, session.id, transition(elementTarget, "changed"), healthy);
    expect(mismatched.status).toBe("inconclusive"); expect(mismatched.context?.checks[0].causal?.readings[0].before).toBeNull();
    const sentinel = "causal-fixture-only-private-fill";
    await act(request, runPhantom, session.id, { type: "fill", selector: "#password", value: sentinel });
    const partialCursor = await act(request, runPhantom, session.id, click("#increment"));
    const partial = await assertRuntime(request, runPhantom, session.id, transition(stateTarget, "increased"), partialCursor);
    expect(partial.status).toBe("inconclusive"); expect(JSON.stringify(partial)).not.toContain(sentinel);
    const forged = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/assert`, { data: {
      predicate: transition(stateTarget, "changed"), since: partialCursor, proof: partial.context?.checks[0].causal,
    } });
    expect(forged.status()).toBe(400);
  });

  test("document replacement invalidates the owned action rather than reusing its result", async ({ page, request, runPhantom, targetApp }) => {
    const session = await connectTarget(page, request, runPhantom, targetApp.origin);
    const since = await act(request, runPhantom, session.id, click("#increment"));
    await page.reload();
    await expect.poll(async () => (await observe(request, runPhantom, session.id)).session.connected).toBe(false);
    const report = await assertRuntime(request, runPhantom, session.id, transition(stateTarget, "increased"), since);
    expect(report.status).toBe("inconclusive"); expect(report.context?.checks[0].causal?.attribution).toBe("unavailable");
  });

  test("the real stdio MCP client receives the same causal and already-true report semantics", async ({ page, request, runPhantom, targetApp }) => {
    const session = await connectTarget(page, request, runPhantom, targetApp.origin);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
      && !key.startsWith("RUNPHANTOM_") && key !== "ANTHROPIC_API_KEY" && key !== "OPENAI_API_KEY")) as Record<string, string>;
    const transport = new StdioClientTransport({ command: "bun", args: ["src/index.ts", "mcp"], cwd: REPO_ROOT_PATH,
      env: { ...env, RUNPHANTOM_URL: runPhantom.url, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } });
    const client = new Client({ name: "causal-browser-user", version: "1" });
    try {
      await client.connect(transport);
      const parse = (output: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((output.content as Array<{ text: string }>)[0].text);
      const action = parse(await client.callTool({ name: "app_act", arguments: { sessionId: session.id, command: click("#increment") } }));
      expect(action.ok).toBe(true);
      const passed = parse(await client.callTool({ name: "app_assert", arguments: { sessionId: session.id, since: action.cursor,
        predicate: transition(stateTarget, "increased"), name: "MCP synchronous transition" } }));
      expect(passed.status).toBe("pass"); expect(passed.context.checks[0].causal.source).toBe("sdk-reported");
      const noop = parse(await client.callTool({ name: "app_act", arguments: { sessionId: session.id, command: click("#noop") } }));
      const already = parse(await client.callTool({ name: "app_assert", arguments: { sessionId: session.id, since: noop.cursor,
        predicate: transition(stateTarget, "becomes", 1), name: "MCP already true" } }));
      expect(already.status).toBe("inconclusive"); expect(already.reason).toContain("already held");
      expect(already.context.checks[0].causal.readings[0]).toMatchObject({ before: { value: 1 }, after: { value: 1 } });
      const delayed = parse(await client.callTool({ name: "app_act", arguments: { sessionId: session.id, command: click("#background") } }));
      const background = parse(await client.callTool({ name: "app_assert", arguments: { sessionId: session.id, since: delayed.cursor,
        predicate: transition(stateTarget, "becomes", 2), name: "MCP background is not the click" } }));
      expect(background.status).toBe("fail"); expect(background.context.checks[0].causal.readings[0].after.value).toBe(1);
      const unmatched = parse(await client.callTool({ name: "app_assert", arguments: { sessionId: session.id, since: delayed.cursor,
        predicate: transition(elementTarget, "changed"), name: "MCP unmatched target" } }));
      expect(unmatched.status).toBe("inconclusive"); expect(unmatched.context.checks[0].causal.attribution).toBe("unavailable");
      await page.evaluate(() => window.runtime.disconnect());
      const incapable = await connectTarget(page, request, runPhantom, targetApp.origin, undefined, false);
      const refused = parse(await client.callTool({ name: "app_act", arguments: { sessionId: incapable.id, command: click("#increment") } }));
      expect(refused.ok).toBe(false); expect(refused.error).toContain("no action was executed");
      const unavailable = parse(await client.callTool({ name: "app_assert", arguments: { sessionId: incapable.id, since: refused.cursor,
        predicate: transition(stateTarget, "changed"), name: "MCP capability unavailable" } }));
      expect(unavailable.status).toBe("inconclusive"); expect(unavailable.context.checks[0].causal.readings[0].before).toBeNull();
      expect(await page.evaluate(() => window.checkoutState.requests)).toBe(0);
    } finally { await client.close(); await transport.close(); }
  });
});
