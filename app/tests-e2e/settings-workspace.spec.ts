import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

const root = path.resolve(import.meta.dirname, "../..");
const test = base.extend<{ local: { url: string } }>({
  local: async ({}, use) => {
    const profile = mkdtempSync(path.join(tmpdir(), "runphantom-settings-ui-"));
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const url = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !/API_KEY|TOKEN|SECRET|PASSWORD|NODE_OPTIONS/.test(key)));
    const child: ChildProcess = spawn("bun", ["src/index.ts", "serve"], { cwd: root, env: { ...env, HOME: profile, USERPROFILE: profile, RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stdout?.on("data", data => { logs = (logs + data).slice(-16000); });
    child.stderr?.on("data", data => { logs = (logs + data).slice(-16000); });
    let launchError: Error | null = null;
    child.on("error", error => { launchError = error; });
    try {
      await expect.poll(async () => {
        if (launchError || child.exitCode !== null) throw new Error(`Local settings fixture failed: ${logs}`);
        return fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }).then(response => response.ok()).catch(() => false);
      }, { timeout: 15000 }).toBe(true);
      await use({ url });
    } finally {
      if (!launchError && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
        try { await exited; } finally { clearTimeout(timer); }
      }
      rmSync(profile, { recursive: true, force: true });
    }
  },
  // Daemon and default profile outlive the browser context and artifact finalizers.
  context: async ({ local: _local, context }, use) => { await use(context); },
});
const screenshot = async (page: import("@playwright/test").Page, name: string) => {
  if (process.env.RUNPHANTOM_F44_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.RUNPHANTOM_F44_SCREENSHOTS, `${name}.png`), fullPage: true });
};

test("settings saves real endpoints, refuses duplicates and preserves drafts after a failed save", async ({ page, local }) => {
  await page.goto(`${local.url}/settings`);
  await page.getByRole("tab", { name: "Agent Endpoints" }).click();
  const panel = page.getByRole("tabpanel", { name: "Agent Endpoints" });
  const name = panel.getByLabel("Agent name", { exact: true });
  const endpoint = panel.getByLabel("Replay endpoint URL", { exact: true });
  const add = panel.getByRole("button", { name: "Add agent endpoint" });
  await expect(name).toBeEnabled();
  await name.fill("Reference replay"); await endpoint.fill("http://127.0.0.1:65530/replay"); await add.click();
  await expect(panel.getByRole("status")).toHaveText("Endpoint Reference replay registered.");
  expect((await (await page.request.get(`${local.url}/api/agents`)).json())["Reference replay"].url).toBe("http://127.0.0.1:65530/replay");
  await name.fill("Reference replay"); await endpoint.fill("http://127.0.0.1:65529/replay"); await add.click();
  await expect(panel.getByRole("alert")).toContainText("already exists");
  expect((await (await page.request.get(`${local.url}/api/agents`)).json())["Reference replay"].url).toBe("http://127.0.0.1:65530/replay");
  await page.route("**/api/agents", async route => { if (route.request().method() === "PUT") await route.fulfill({ status: 503, json: { error: "Registry is temporarily read-only" } }); else await route.continue(); });
  await name.fill("Second replay"); await add.click();
  await expect(panel.getByRole("alert")).toContainText("temporarily read-only");
  await expect(name).toHaveValue("Second replay"); await expect(endpoint).toHaveValue("http://127.0.0.1:65529/replay");
  expect((await (await page.request.get(`${local.url}/api/agents`)).json())["Second replay"]).toBeUndefined();
  await page.unroute("**/api/agents"); await add.click(); await expect(name).toHaveValue("");
  await panel.getByRole("button", { name: "Remove Second replay", exact: true }).click();
  await expect(panel.getByText("Second replay", { exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`${local.url}/api/agents`)).json())["Second replay"]).toBeUndefined();
  await screenshot(page, "settings-endpoints-desktop");
});

test("settings keeps an unread registry protected and supports narrow keyboard reflow", async ({ page, local }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.route("**/api/agents", async route => route.fulfill({ status: 503, json: { error: "Registry unavailable" } }));
  await page.goto(`${local.url}/settings`);
  const keys = page.getByRole("tab", { name: "API Keys" }); await keys.focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Agent Endpoints" })).toBeFocused();
  await expect(page.getByRole("alert")).toContainText("Registry unavailable");
  await expect(page.getByLabel("Agent name", { exact: true })).toBeDisabled();
  await page.unroute("**/api/agents"); await page.getByRole("button", { name: "Try loading again" }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toBeEnabled();
  await screenshot(page, "settings-endpoints-320");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("tab", { name: "Agent Endpoints" }).focus(); await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Debug" })).toBeFocused();
  await page.getByRole("button", { name: "show again" }).click(); await expect(page.getByRole("button", { name: "reset" })).toBeVisible();
});

test("settings reports key status and clipboard refusal without claiming success", async ({ page, local }) => {
  await page.route("**/api/secrets", route => route.fulfill({ status: 503, json: { error: "Key status unavailable" } }));
  await page.goto(`${local.url}/settings`);
  await expect(page.getByRole("alert")).toContainText("Saved key status is unavailable");
  await page.unroute("**/api/secrets"); await page.getByRole("button", { name: "Try loading key status again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("tab", { name: "Agent Endpoints" }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
    document.execCommand = () => false;
  });
  await page.getByRole("button", { name: "Copy Setup Prompt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Clipboard access was denied");
  await expect(page.getByRole("button", { name: "Copied!", exact: true })).toHaveCount(0);
});

test("settings ignores a late save after changing tabs and unknown routes recover", async ({ page, local }) => {
  await page.goto(`${local.url}/settings`); await page.getByRole("tab", { name: "Agent Endpoints" }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toBeEnabled();
  await page.getByLabel("Agent name", { exact: true }).fill("Delayed replay"); await page.getByLabel("Replay endpoint URL", { exact: true }).fill("http://127.0.0.1:65530/replay");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let admitted!: () => void; const admittedPromise = new Promise<void>(resolve => { admitted = resolve; });
  const pending = new Set<Promise<void>>();
  const handler = (route: import("@playwright/test").Route) => {
    const work = (async () => { if (route.request().method() !== "PUT") return route.continue(); const response = await route.fetch(); admitted(); await gate; await route.fulfill({ response }); })();
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  await page.route("**/api/agents", handler);
  try {
    await page.getByRole("button", { name: "Add agent endpoint" }).click(); await admittedPromise;
    await page.getByRole("tab", { name: "Debug" }).click(); release(); await Promise.all([...pending]);
    await expect(page.getByRole("tabpanel", { name: "Debug" })).toBeVisible();
    await expect(page.getByText("Endpoint Delayed replay registered.", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Agent Endpoints" }).click(); await expect(page.getByText("Delayed replay", { exact: true })).toBeVisible();
  } finally { release(); await page.unroute("**/api/agents", handler); await Promise.all([...pending]); }
  await page.goto(`${local.url}/missing-reference-page`); await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await screenshot(page, "missing-route-desktop"); await page.getByRole("button", { name: "Back to traces" }).click(); await expect(page).toHaveURL(/\/runs/);
});


test("settings keeps saved keys write-only and clears the actual local store", async ({ page, local }) => {
  await page.goto(`${local.url}/settings`);
  const panel = page.getByRole("tabpanel", { name: "API Keys" });
  const input = panel.getByLabel("OpenAI", { exact: true });
  await expect(panel.getByText("Checking saved key status…", { exact: true })).toHaveCount(0);
  const synthetic = "fixture-only-key-with-no-provider-authorization";
  await input.fill(synthetic); await panel.getByRole("button", { name: "Save OpenAI key" }).click();
  await expect(panel.getByText("saved", { exact: true })).toBeVisible(); await expect(input).toHaveValue("");
  const savedResponse = await page.request.get(`${local.url}/api/secrets`); const body = await savedResponse.text();
  expect(body).not.toContain(synthetic); expect(JSON.parse(body).keys.openai.stored).toBe(true);
  await page.reload(); await expect(panel.getByText("saved", { exact: true })).toBeVisible(); await expect(input).toHaveValue("");
  await panel.getByRole("button", { name: "Clear saved OpenAI key" }).click(); await expect(panel.getByText("saved", { exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`${local.url}/api/secrets`)).json()).keys.openai.stored).toBe(false);
  await screenshot(page, "settings-keys-desktop");
});
