import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { WebSocket } from "ws";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect, REPO_ROOT_PATH, type RunPhantomHandle } from "./fixtures";
import type { VerificationChangeContext, VerificationReport } from "../../src/verification/protocol";

const name = "Retained checkout failure for change review";
const widths = [360, 390, 768, 1024, 1440, 1920];
const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const evidenceDirectory = process.env.RUNPHANTOM_F32_EVIDENCE_DIR ?? path.join(REPO_ROOT_PATH, "output", "f32-change-context");

function recordOwnedSourceHost(daemon: RunPhantomHandle, report: VerificationReport): void {
  if (process.env.RUNPHANTOM_F32_RECORD_NATIVE !== "1") return;
  const listener = spawnSync("lsof", ["-nP", `-iTCP:${daemon.port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 1000 });
  const ids = [...new Set(listener.stdout.trim().split(/\s+/))];
  expect(ids).toHaveLength(1); expect(ids[0]).toMatch(/^\d+$/);
  const identity = spawnSync("ps", ["-p", ids[0], "-o", "pid=,lstart=,comm="], { encoding: "utf8", timeout: 1000 });
  const cwd = spawnSync("lsof", ["-a", "-p", ids[0], "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 1000 });
  expect(identity.stdout).toContain("bun"); expect(cwd.stdout).toContain(`n${realpathSync(REPO_ROOT_PATH)}`);
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(path.join(evidenceDirectory, `source-host-${report.id}.json`), JSON.stringify({
    scope: "Optional owned macOS source-host identity observation; core browser journeys remain platform-independent",
    pid: Number(ids[0]), birthWitness: identity.stdout.trim(), listenerPort: daemon.port,
    cwdWitness: cwd.stdout.trim(), ownedProfile: path.dirname(daemon.dbPath), dbPath: daemon.dbPath,
    reportId: report.id, verdict: report.status,
  }, null, 2));
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Divyam Talwar", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", timeout: 1000 });
  if (result.status !== 0) throw new Error(`Owned native Git ${args[0]} failed`);
  return result.stdout.trim();
}

async function measuredFixture(request: APIRequestContext, daemon: RunPhantomHandle) {
  const directory = realpathSync(mkdtempSync(path.join(path.dirname(daemon.dbPath), "selected-project-")));
  git(directory, "init", "-q"); mkdirSync(path.join(directory, "src")); mkdirSync(path.join(directory, "tests"));
  writeFileSync(path.join(directory, "src/Cart.tsx"), "export const Cart = 'original';\n");
  writeFileSync(path.join(directory, "tests/Checkout.test.ts"), "// Related filename only; this file has not been executed.\n");
  git(directory, "add", "--", "."); git(directory, "commit", "-qm", "Retain owned native change review fixture");
  const head = git(directory, "rev-parse", "HEAD");
  git(directory, "mv", "--", "src/Cart.tsx", "src/Checkout.tsx");
  writeFileSync(path.join(directory, "src/Checkout.tsx"), "export const Cart = 'changed';\n");
  writeFileSync(path.join(directory, "src/欢迎.mdx"), "PRIVATE_UNTRACKED_CHANGE_REVIEW_CONTENT\n");
  writeFileSync(path.join(directory, ".env"), "PASSWORD=PRIVATE_CHANGE_REVIEW_SECRET\n");

  const created = await request.post(`${daemon.url}/api/verification/sessions`, { data: { origin: "http://localhost:4812" } });
  expect(created.status()).toBe(201);
  const session = await created.json();
  const ws = new WebSocket(`${daemon.url.replace("http:", "ws:")}/verification/ws?sessionId=${session.id}`, { headers: { Origin: session.origin } });
  await once(ws, "open"); const ready = once(ws, "message");
  ws.send(JSON.stringify({ type: "hello", version: 1, token: session.token, coverage }));
  expect(JSON.parse((await ready)[0].toString()).type).toBe("ready");
  // Controlled SDK protocol peer; this is not a browser-host instrumentation claim.
  ws.on("message", raw => {
    const message = JSON.parse(raw.toString()); if (message.type !== "command") return;
    if (message.command.type === "click") {
      ws.send(JSON.stringify({ type: "event", event: { type: "action.boundary", actionId: message.id, data: {} } }));
      ws.send(JSON.stringify({ type: "event", event: { type: "console", actionId: message.id, data: { level: "error", message: "Observed checkout error; completion prose does not establish success." } } }));
    }
    ws.send(JSON.stringify({ type: "result", id: message.id, ok: true }));
  });
  const action = await request.post(`${daemon.url}/api/verification/sessions/${session.id}/command`, { data: { type: "click", selector: "#pay" } });
  expect(action.ok()).toBe(true); const acted = await action.json(); expect(acted.ok).toBe(true);
  const checked = await request.post(`${daemon.url}/api/verification/sessions/${session.id}/assert`, { data: {
    name, predicate: { kind: "console", level: "error", absent: true }, since: acted.cursor,
  } });
  expect(checked.ok()).toBe(true); const report = await checked.json() as VerificationReport; expect(report.status).toBe("fail");
  recordOwnedSourceHost(daemon, report);
  const originalReports = await (await request.get(`${daemon.url}/api/verification/reports`)).text();
  const selectionFile = path.join(path.dirname(daemon.dbPath), ".runphantom", "active-workspace.json");
  const select = async () => {
    const response = await request.post(`${daemon.url}/api/workspace/active`, { data: { cwd: directory } });
    expect(response.ok()).toBe(true); expect((await response.json()).cwd).toBe(directory);
    const persisted = JSON.parse(readFileSync(selectionFile, "utf8")); expect(persisted.cwd).toBe(directory);
  };
  const unchanged = async () => expect(await (await request.get(`${daemon.url}/api/verification/reports`)).text()).toBe(originalReports);
  return { directory, head, report, selectionFile, select, unchanged, close: () => ws.terminate() };
}

async function reportPanel(page: Page, daemon: RunPhantomHandle): Promise<Locator> {
  await page.goto(`${daemon.url}/verification`);
  await expect(page.getByRole("heading", { name: "Verification", exact: true })).toBeVisible();
  const article = page.getByRole("article", { name: `${name}: fail`, exact: true });
  await expect(article).toBeVisible();
  return article;
}

async function prepare(article: Locator): Promise<void> {
  await article.getByRole("button", { name: "Prepare failure handoff", exact: true }).click();
  await expect(article.getByRole("checkbox", { name: /^Use selected workspace:/ })).not.toBeChecked();
  await expect(article.getByRole("button", { name: "Review selected changes", exact: true })).toBeDisabled();
}

async function capture(page: Page, article: Locator): Promise<VerificationChangeContext> {
  await article.getByRole("checkbox", { name: /^Use selected workspace:/ }).check();
  const response = page.waitForResponse(value => value.request().method() === "POST" && value.url().endsWith("/change-context"));
  await article.getByRole("button", { name: "Review selected changes", exact: true }).click();
  const captured = await response; expect(captured.status()).toBe(200);
  await expect(article.getByRole("button", { name: "Copy measured handoff", exact: true })).toBeVisible();
  return captured.json() as Promise<VerificationChangeContext>;
}

test("default change review requires persisted selection and opt-in, exports the measured failure and fits six widths", async ({ page, context, request, runPhantom }) => {
  const fixture = await measuredFixture(request, runPhantom);
  try {
    rmSync(fixture.selectionFile, { force: true });
    expect((await request.get(`${runPhantom.url}/api/verification/change-workspace`)).status()).toBe(409);
    let article = await reportPanel(page, runPhantom);
    await article.getByRole("button", { name: "Prepare failure handoff", exact: true }).click();
    await expect(article.getByRole("status")).toContainText("Select an active workspace explicitly");
    await fixture.select(); await prepare(article);
    await article.getByRole("button", { name: "Cancel review", exact: true }).click();
    await expect(article.getByRole("status")).toContainText("saved report is unchanged");
    await prepare(article);
    const captured = await capture(page, article);
    expect(captured.head).toBe(fixture.head); expect(captured.handoff.reportId).toBe(fixture.report.id);
    expect(captured.handoff.status).toBe("fail"); expect(captured.testedRevision).toBeNull();
    expect(captured.changes).toContainEqual(expect.objectContaining({ path: "src/Checkout.tsx", previousPath: "src/Cart.tsx" }));
    expect(captured.relatedTests).toContainEqual({ path: "tests/Checkout.test.ts", reason: "filename", advisory: true });
    await expect(article.getByText("Tested revision: unavailable.", { exact: false })).toBeVisible();
    await expect(article.getByText("Filename match; not executed", { exact: false })).toBeVisible();
    const rendered = await article.innerText();
    for (const withheld of ["PRIVATE_UNTRACKED_CHANGE_REVIEW_CONTENT", "PRIVATE_CHANGE_REVIEW_SECRET", ".env", fixture.directory]) expect(rendered).not.toContain(withheld);
    await article.getByText("Retained handoff JSON", { exact: true }).click();
    expect(JSON.parse(await article.locator("pre").innerText())).toEqual(captured.handoff);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: runPhantom.url });
    await article.getByRole("button", { name: "Copy measured handoff", exact: true }).click();
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(captured.handoff);
    await fixture.unchanged();
    await page.reload(); article = page.getByRole("article", { name: `${name}: fail`, exact: true });
    await expect(article.getByRole("button", { name: "Prepare failure handoff", exact: true })).toBeVisible();
    await expect(article.getByText("Saved measured outcome: fail", { exact: false })).toHaveCount(0);
    mkdirSync(evidenceDirectory, { recursive: true }); const measurements = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 }); await page.reload();
      article = page.getByRole("article", { name: `${name}: fail`, exact: true }); await prepare(article);
      await article.getByRole("heading", { name: "Change-aware QA", exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }));
      await page.evaluate(() => document.fonts.load("700 18px Syne"));
      await page.screenshot({ path: path.join(evidenceDirectory, `native-default-offer-${width}.png`), fullPage: true });
      await capture(page, article);
      const action = article.getByRole("button", { name: "Copy measured handoff", exact: true }); await action.scrollIntoViewIfNeeded();
      const box = await action.boundingBox(); expect(box?.height).toBeGreaterThanOrEqual(44); expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      const font = await page.evaluate(async () => { await document.fonts.load("700 18px Syne"); return document.fonts.check("700 18px Syne"); }); expect(font).toBe(true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); expect(overflow).toBe(false);
      await page.screenshot({ path: path.join(evidenceDirectory, `native-default-${width}.png`), fullPage: true });
      measurements.push({ width, height: 900, box, syneLoaded: font, overflow }); await fixture.unchanged();
    }
    writeFileSync(path.join(evidenceDirectory, "six-width-default-source-measurements.json"), JSON.stringify({ scope: "Actual default source page offer/header and lower handoff viewports; application uses an internal scroll pane. Controlled SDK wire and native Git; manual image review pending", measurements }, null, 2));
  } finally { fixture.close(); }
});

for (const mode of ["cancel", "navigate away"] as const) {
  test(`default change review discards a held genuine response after ${mode}`, async ({ page, request, runPhantom }) => {
    const fixture = await measuredFixture(request, runPhantom); await fixture.select();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let observed!: () => void; const actual = new Promise<void>(resolve => { observed = resolve; });
    let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; }); let status = 0;
    await page.route("**/change-context", async route => {
      const response = await route.fetch(); status = response.status(); observed(); await held;
      try { await route.fulfill({ response }); } catch { /* The actual canceled request may already be closed. */ } finally { finished(); }
    });
    try {
      let article = await reportPanel(page, runPhantom); await prepare(article);
      await article.getByRole("checkbox", { name: /^Use selected workspace:/ }).check();
      await article.getByRole("button", { name: "Review selected changes", exact: true }).click();
      await actual; expect(status).toBe(200);
      if (mode === "cancel") await article.getByRole("button", { name: "Cancel review", exact: true }).click();
      else await page.goto(`${runPhantom.url}/runs`);
      release(); await done;
      if (mode === "cancel") await expect(article.getByRole("status")).toContainText("Review cancelled");
      else article = await reportPanel(page, runPhantom);
      await expect(article.getByText("Saved measured outcome: fail", { exact: false })).toHaveCount(0);
      await expect(article.getByRole("button", { name: "Prepare failure handoff", exact: true })).toBeVisible();
      await fixture.unchanged();
    } finally { release(); fixture.close(); }
  });
}

test("default local change review rejects stale or cleared selection and hostile origin without changing the report", async ({ page, request, runPhantom }) => {
  const fixture = await measuredFixture(request, runPhantom); await fixture.select();
  try {
    const article = await reportPanel(page, runPhantom); await prepare(article); await fixture.select();
    await article.getByRole("checkbox", { name: /^Use selected workspace:/ }).check();
    const stale = page.waitForResponse(value => value.url().endsWith("/change-context"));
    await article.getByRole("button", { name: "Review selected changes", exact: true }).click();
    expect((await stale).status()).toBe(409); await expect(article.getByRole("status")).toContainText("changed");
    await expect(article.getByText("Saved measured outcome: fail", { exact: false })).toHaveCount(0); await fixture.unchanged();
    await prepare(article); rmSync(fixture.selectionFile, { force: true });
    await article.getByRole("checkbox", { name: /^Use selected workspace:/ }).check();
    const cleared = page.waitForResponse(value => value.url().endsWith("/change-context"));
    await article.getByRole("button", { name: "Review selected changes", exact: true }).click();
    expect((await cleared).status()).toBe(409); await expect(article.getByRole("status")).toContainText("changed");
    await fixture.select(); const offer = await (await request.get(`${runPhantom.url}/api/verification/change-workspace`)).json();
    const refused = await request.post(`${runPhantom.url}/api/verification/reports/${fixture.report.id}/change-context`, {
      headers: { Origin: "https://hostile.example.invalid" }, data: { workspaceId: offer.workspaceId },
    });
    expect(refused.status()).toBe(403); expect(JSON.stringify(await refused.json())).not.toContain(fixture.directory);
    await fixture.unchanged(); await prepare(article); await capture(page, article); await fixture.unchanged();
  } finally { fixture.close(); }
});
