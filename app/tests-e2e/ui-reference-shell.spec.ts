import type { Locator, Page, TestInfo, WebSocketRoute } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { DatasetExport, DatasetRevision } from "../../src/evaluations/protocol";
import { expect, test } from "./fixtures";
import {
  FIXTURE_LIVE_RUN_ID,
  FIXTURE_PRIMARY_RUN_ID,
  FIXTURE_SPAN_COUNT,
  readRunPhantomRun,
  readRunPhantomSpans,
  seedRunPhantomFixtures,
} from "./helpers";

const SECTIONS = [
  { name: "Runs", path: "/runs" },
  { name: "Search", path: "/search" },
  { name: "Saved", path: "/saved" },
  { name: "Verification", path: "/verification" },
  { name: "Evaluations", path: "/evaluations" },
  { name: "Settings", path: "/settings" },
] as const;
const MOBILE_WIDTHS = new Set([390, 320]);

async function expectHeader(page: Page, section: string) {
  const header = page.locator("[data-workspace-header]");
  await expect(header).toBeVisible();
  await expect(header.getByText(section, { exact: true })).toBeVisible();
  const connection = header.locator("[data-connection-status]");
  await expect(connection).toHaveAttribute("data-connection-status", "connected");
  await expect(connection).toContainText(/connected/i);
  const box = await header.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(64);
  expect(box!.height).toBeLessThanOrEqual(72);
  expect(await header.evaluate(element => getComputedStyle(element).position)).not.toBe("absolute");
  expect(await header.evaluate(element => getComputedStyle(element).position)).not.toBe("fixed");
  const sectionBox = (await header.getByText(section, { exact: true }).boundingBox())!;
  for (const control of [connection, header.getByRole("button", { name: "Toggle Sidebar", exact: true })]) {
    const controlBox = (await control.boundingBox())!;
    expect(sectionBox.x < controlBox.x + controlBox.width && controlBox.x < sectionBox.x + sectionBox.width
      && sectionBox.y < controlBox.y + controlBox.height && controlBox.y < sectionBox.y + sectionBox.height,
    `${section} breadcrumb must not overlap header controls`).toBe(false);
  }
}

async function expectUnobscured(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(await control.evaluate(element => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return top === element || (top !== null && element.contains(top));
  }), "a visible control must receive a real user click").toBe(true);
}

async function expectNoOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
}

async function openNavigation(page: Page, mobile: boolean) {
  if (!mobile) return page.locator('[data-sidebar="sidebar"]').first();
  const trigger = page.getByRole("button", { name: "Toggle Sidebar", exact: true });
  await expectUnobscured(trigger);
  const box = await trigger.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function expectNavigationType(navigation: Locator, mobile: boolean) {
  const brand = navigation.getByRole("link", { name: /^Run Phantom/ }).getByText("Run Phantom", { exact: true });
  await expect(brand).toBeVisible();
  const typography = await brand.evaluate(element => ({
    size: parseFloat(getComputedStyle(element).fontSize),
    family: getComputedStyle(element).fontFamily,
  }));
  expect(typography.size).toBeGreaterThanOrEqual(18);
  expect(typography.family).toContain("Syne");
  for (const section of SECTIONS) {
    const link = navigation.getByRole("link", { name: section.name, exact: true });
    await expect(link).toBeVisible();
    expect(await link.locator("span").last().evaluate(element => parseFloat(getComputedStyle(element).fontSize)), `${section.name} rail text`).toBeGreaterThanOrEqual(14);
    if (mobile) expect((await link.boundingBox())!.height, `${section.name} touch target`).toBeGreaterThanOrEqual(44);
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const destination = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: destination });
  await testInfo.attach(name, { path: destination, contentType: "image/png" });
}

for (const width of [1440, 1024, 390, 320]) {
  test(`reference shell: real routes, readable navigation and unobscured header at ${width}px`, async ({ page, runPhantom }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const frames: string[] = [];
    page.on("websocket", socket => {
      if (new URL(socket.url()).pathname !== "/ws") return;
      socket.on("framereceived", frame => frames.push(String(frame.payload)));
    });
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    await seedRunPhantomFixtures(runPhantom.url);
    await page.goto(`${runPhantom.url}/runs`);
    await expectHeader(page, "Runs");
    await expect.poll(() => frames.some(frame => {
      try { return JSON.parse(frame).event === "agent_provider"; } catch { return false; }
    }), { message: "connected status requires real daemon WebSocket traffic" }).toBe(true);
    const mobile = MOBILE_WIDTHS.has(width);
    const liveRunBefore = await readRunPhantomRun(runPhantom.url, FIXTURE_LIVE_RUN_ID);
    const liveSpansBefore = await readRunPhantomSpans(runPhantom.url, FIXTURE_LIVE_RUN_ID);
    expect(liveRunBefore).not.toBeNull();
    expect(liveSpansBefore.length).toBeGreaterThan(0);
    let navigation = await openNavigation(page, mobile);
    await expectNavigationType(navigation, mobile);
    const theme = await page.evaluate(async () => {
      await document.fonts.ready;
      const style = getComputedStyle(document.documentElement);
      return {
        accent: style.getPropertyValue("--rp-accent").trim().toUpperCase(),
        canvas: style.getPropertyValue("--rp-canvas").trim().toUpperCase(),
        ink: style.getPropertyValue("--rp-ink").trim().toUpperCase(),
        syneLoaded: [...document.fonts].some(font => font.family.replace(/["']/g, "") === "Syne" && font.status === "loaded"),
      };
    });
    expect(theme).toEqual({ accent: "#0021CC", canvas: "#F9FAFC", ink: "#0E121B", syneLoaded: true });
    if (mobile) {
      await page.keyboard.press("Escape");
      await expect(navigation).toBeHidden();
      await expect(page.getByRole("button", { name: "Toggle Sidebar", exact: true })).toBeFocused();
    }
    for (const section of SECTIONS) {
      navigation = await openNavigation(page, mobile);
      await navigation.getByRole("link", { name: section.name, exact: true }).click();
      const expectedPath = section.name === "Runs" && !mobile
        ? `/runs/${FIXTURE_LIVE_RUN_ID}`
        : section.path;
      await expect(page).toHaveURL(`${runPhantom.url}${expectedPath}`);
      if (section.name === "Runs") {
        if (!mobile) await expect(page.getByRole("tab", { name: "Span Tree", exact: true })).toBeVisible();
        expect(await readRunPhantomRun(runPhantom.url, FIXTURE_LIVE_RUN_ID)).toEqual(liveRunBefore);
        expect(await readRunPhantomSpans(runPhantom.url, FIXTURE_LIVE_RUN_ID)).toEqual(liveSpansBefore);
      }
      await expectHeader(page, section.name);
      if (mobile) await expect(page.getByRole("dialog", { name: "Navigation", exact: true })).toBeHidden();
      else await expect(navigation.getByRole("link", { name: section.name, exact: true })).toHaveAttribute("aria-current", "page");
      await expectNoOverflow(page, width);
    }
    await page.reload();
    await expectHeader(page, "Settings");
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await expectHeader(page, "Runs");
    await expect(page.getByRole("tab", { name: "Span Tree", exact: true })).toBeVisible();
    await expectNoOverflow(page, width);
    await capture(page, testInfo, `reference-shell-${width}`);
    expect(errors).toEqual([]);
  });
}

test("reference shell: keyboard navigation, active-section clicks and browser Back retain working history", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expectHeader(page, "Runs");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to trace workspace", exact: true });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#runphantom-main")).toBeFocused();
  const previousLocation = page.url();
  expect(previousLocation).toBe(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}#runphantom-main`);
  const navigation = page.locator('[data-sidebar="sidebar"]').first();
  const search = navigation.getByRole("link", { name: "Search", exact: true });
  await search.focus();
  await page.keyboard.press("Enter");
  await expectHeader(page, "Search");
  await expect(search).toHaveAttribute("aria-current", "page");
  await search.click();
  await search.click();
  await page.goBack();
  await expect(page).toHaveURL(previousLocation);
  await expectHeader(page, "Runs");
  await expect(navigation.getByRole("link", { name: "Runs", exact: true })).toHaveAttribute("aria-current", "page");
});

test("reference shell: an actual captured span and its output remain unchanged through navigation and reload", async ({ page, runPhantom }, testInfo) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const beforeRun = await readRunPhantomRun(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);
  const beforeSpans = await readRunPhantomSpans(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);
  expect(beforeRun?.id).toBe(FIXTURE_PRIMARY_RUN_ID);
  expect(beforeSpans).toHaveLength(FIXTURE_SPAN_COUNT);
  const root = beforeSpans.find(span => span.name === "agent.turn");
  expect(root?.output_payload).toContain("Changed 'traec viewer' to 'trace viewer' on line 3.");
  await page.goto(`${runPhantom.url}/runs`);
  await page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`).click();
  await expectHeader(page, "Runs");
  await page.getByRole("tab", { name: "Span Tree", exact: true }).click();
  await expect(page.locator(`[data-span-row="${root!.id}"]`)).toBeVisible();
  await page.locator(`[data-span-row="${root!.id}"]`).click();
  await expect(page).toHaveURL(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}/span/${root!.id}`);
  await expect(page.getByText("Changed 'traec viewer' to 'trace viewer' on line 3.", { exact: false }).first()).toBeVisible();
  await page.reload();
  await expectHeader(page, "Runs");
  await expect(page.getByText("Changed 'traec viewer' to 'trace viewer' on line 3.", { exact: false }).first()).toBeVisible();
  expect(await readRunPhantomRun(runPhantom.url, FIXTURE_PRIMARY_RUN_ID)).toEqual(beforeRun);
  expect(await readRunPhantomSpans(runPhantom.url, FIXTURE_PRIMARY_RUN_ID)).toEqual(beforeSpans);
  await capture(page, testInfo, "reference-shell-captured-output");
});

test("reference shell: reduced motion removes drawer movement while retaining focus and navigation", async ({ page, runPhantom }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs`);
  await expectHeader(page, "Runs");
  const drawer = await openNavigation(page, true);
  const motion = await drawer.evaluate(element => {
    const style = getComputedStyle(element);
    return { transition: style.transitionDuration.split(",").map(parseFloat), animation: style.animationDuration.split(",").map(parseFloat), transform: style.transform };
  });
  expect(motion.transition.every(duration => duration <= 0.001)).toBe(true);
  expect(motion.animation.every(duration => duration <= 0.001)).toBe(true);
  expect(motion.transform).toBe("none");
  await drawer.getByRole("link", { name: "Search", exact: true }).click();
  await expectHeader(page, "Search");
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("button", { name: "Toggle Sidebar", exact: true })).toBeFocused();
});

test("reference shell: real WebSocket closure reports offline and reconnects without a fabricated status", async ({ page, runPhantom }, testInfo) => {
  let socket: WebSocketRoute | undefined;
  let outage = false;
  const serverFrames: string[] = [];
  await page.routeWebSocket("**/ws", route => {
    if (outage) { void route.close({ code: 1013, reason: "Test transport unavailable" }); return; }
    socket = route;
    const server = route.connectToServer();
    server.onMessage(message => {
      serverFrames.push(String(message));
      route.send(message);
    });
  });
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs`);
  await expectHeader(page, "Runs");
  await expect.poll(() => serverFrames.length).toBeGreaterThan(0);
  const before = serverFrames.length;
  outage = true;
  await socket!.close({ code: 1001, reason: "Test connection interrupted" });
  await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "disconnected");
  const offline = page.getByRole("alertdialog", { name: "Run Phantom isn't running.", exact: true });
  await expect(offline).toBeVisible();
  await expect(offline).toBeFocused();
  await capture(page, testInfo, "reference-shell-connection-interrupted");
  outage = false;
  await expectHeader(page, "Runs");
  await expect.poll(() => serverFrames.length).toBeGreaterThan(before);
  await expect(offline).toBeHidden();
  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible();
});

test.describe("reference shell touch primitives", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("a coarse-pointer user reads 16px controls and creates a retained dataset", async ({ page, request, runPhantom }, testInfo) => {
    await seedRunPhantomFixtures(runPhantom.url);
    const seeded = await request.post(`${runPhantom.url}/api/evaluations/datasets`, { data: { name: "Existing touch dataset" } });
    expect(seeded.status()).toBe(201);
    const existing = await seeded.json() as DatasetRevision;
    await page.goto(`${runPhantom.url}/evaluations`);
    await expectHeader(page, "Evaluations");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const name = page.getByRole("textbox", { name: "Dataset name", exact: true });
    const dataset = page.getByRole("combobox", { name: "Dataset", exact: true });
    await expect(dataset).toHaveValue(existing.datasetId);
    await page.getByText("Import and export datasets", { exact: true }).tap();
    const json = page.getByRole("textbox", { name: "Dataset JSON", exact: true });
    const metrics = [];
    for (const [label, control] of [["Dataset name", name], ["Dataset", dataset], ["Dataset JSON", json]] as const) {
      await expect(control).toBeVisible();
      const metric = await control.evaluate(element => ({
        tag: element.tagName,
        fontSize: getComputedStyle(element).fontSize,
        height: element.getBoundingClientRect().height,
      }));
      expect(metric.fontSize, `${label} must stay legible without mobile text zoom`).toBe("16px");
      expect(metric.height, `${label} touch target`).toBeGreaterThanOrEqual(44);
      metrics.push({ label, ...metric });
    }
    expect(metrics.map(metric => metric.tag)).toEqual(["INPUT", "SELECT", "TEXTAREA"]);
    await expectNoOverflow(page, 390);
    const typedJson = '{"format":"runphantom-evaluations/v1","name":"Touch draft","cases":[]}';
    await json.tap();
    await json.fill(typedJson);
    await expect(json).toHaveValue(typedJson);
    await json.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
    await expectUnobscured(json);
    await capture(page, testInfo, "reference-touch-readable-json");
    await name.tap();
    await name.pressSequentially("Touch-created regression dataset");
    await expect(name).toHaveValue("Touch-created regression dataset");
    const createdResponse = page.waitForResponse(response => response.request().method() === "POST"
      && response.url() === `${runPhantom.url}/api/evaluations/datasets`);
    await page.getByRole("button", { name: "Create dataset", exact: true }).tap();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const saved = await created.json() as DatasetRevision;
    expect(saved).toMatchObject({ datasetName: "Touch-created regression dataset", version: 1, cases: [] });
    await expect(dataset).toHaveValue(saved.datasetId);
    const persisted = await request.get(`${runPhantom.url}/api/evaluations/datasets/${saved.datasetId}`);
    expect(persisted.status()).toBe(200);
    expect(await persisted.json()).toEqual(saved);
    await page.reload();
    await expectHeader(page, "Evaluations");
    await dataset.selectOption(saved.datasetId);
    await expect(dataset).toHaveValue(saved.datasetId);
    await expect(dataset.locator("option:checked")).toHaveText("Touch-created regression dataset");
    await expectNoOverflow(page, 390);
    await capture(page, testInfo, "reference-touch-created-dataset");
    await testInfo.attach("touch-control-metrics", { body: JSON.stringify({ coarsePointer: true, controls: metrics }), contentType: "application/json" });
  });
});

test("reference shell: keyboard focus contrasts on primary and outline controls while create and export work", async ({ page, request, runPhantom }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/evaluations`);
  await expectHeader(page, "Evaluations");
  const name = page.getByRole("textbox", { name: "Dataset name", exact: true });
  await name.fill("Keyboard-focused dataset");
  await name.press("Tab");
  const primary = page.getByRole("button", { name: "Create dataset", exact: true });
  await expect(primary).toBeFocused();
  expect(await primary.evaluate(element => element.matches(":focus-visible"))).toBe(true);
  const primaryStyle = await primary.evaluate(element => {
    const style = getComputedStyle(element);
    return { outlineColor: style.outlineColor, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle, background: style.backgroundColor, shadow: style.boxShadow };
  });
  expect(primaryStyle).toMatchObject({ outlineColor: "rgb(255, 255, 255)", outlineWidth: "2px", outlineOffset: "-4px",
    outlineStyle: "solid", background: "rgb(0, 33, 204)" });
  expect(primaryStyle.shadow).toContain("rgb(0, 33, 204)");
  await expectUnobscured(primary);
  await capture(page, testInfo, "reference-primary-keyboard-focus");
  const createdResponse = page.waitForResponse(response => response.request().method() === "POST"
    && response.url() === `${runPhantom.url}/api/evaluations/datasets`);
  await page.keyboard.press("Enter");
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const saved = await created.json() as DatasetRevision;
  await expect(page.getByRole("combobox", { name: "Dataset", exact: true })).toHaveValue(saved.datasetId);
  const disclosure = page.getByText("Import and export datasets", { exact: true });
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Dataset JSON", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Import dataset file", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const outline = page.getByRole("button", { name: "Export selected revision", exact: true });
  await expect(outline).toBeFocused();
  expect(await outline.evaluate(element => element.matches(":focus-visible"))).toBe(true);
  const outlineStyle = await outline.evaluate(element => {
    const style = getComputedStyle(element);
    return { outlineColor: style.outlineColor, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle, background: style.backgroundColor };
  });
  expect(outlineStyle).toEqual({ outlineColor: "rgb(0, 33, 204)", outlineWidth: "2px", outlineOffset: "-2px",
    outlineStyle: "solid", background: "rgb(255, 255, 255)" });
  await expectUnobscured(outline);
  await capture(page, testInfo, "reference-outline-keyboard-focus");
  const downloaded = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const download = await downloaded, destination = testInfo.outputPath("keyboard-exported-dataset.json");
  await download.saveAs(destination);
  const exported = JSON.parse(await readFile(destination, "utf8")) as DatasetExport;
  expect(exported).toEqual({ format: "runphantom-evaluations/v1", name: "Keyboard-focused dataset", cases: [] });
  const persisted = await request.get(`${runPhantom.url}/api/evaluations/datasets/${saved.datasetId}/export?version=1`);
  expect(persisted.status()).toBe(200);
  expect(await persisted.json()).toEqual(exported);
  await expect(page.getByRole("textbox", { name: "Dataset JSON", exact: true })).toHaveValue(JSON.stringify(exported, null, 2));
  await testInfo.attach("keyboard-control-focus-styles", { body: JSON.stringify({ primary: primaryStyle, outline: outlineStyle }), contentType: "application/json" });
});

for (const viewport of [
  { label: "desktop", width: 1440, height: 900, compact: false },
  { label: "compact", width: 390, height: 844, compact: true },
]) {
  test.describe(`reference shell: ${viewport.label} Debug allocated height`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.compact });

    test("keeps the complete composer reachable with real keyboard and send controls", async ({ page, runPhantom }, testInfo) => {
      await seedRunPhantomFixtures(runPhantom.url);
      await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
      await expectHeader(page, "Runs");
      const launcher = page.getByRole("button", { name: "Debug", exact: true });
      if (viewport.compact) await launcher.tap();
      else {
        await launcher.focus();
        await page.keyboard.press("Enter");
      }
      const pane = page.getByRole(viewport.compact ? "dialog" : "complementary", { name: "Coding-agent debug chat" });
      const composer = pane.getByRole("combobox", { name: "Ask about this trace", exact: true });
      const send = pane.getByRole("button", { name: "Send message", exact: true });
      await expect(pane).toBeVisible();
      await expect(composer).toBeAttached();
      await expect(send).toBeAttached();
      await expect(pane.getByText("Connect your coding agent", { exact: true })).toHaveCount(0);
      const geometry = await pane.evaluate(element => {
        const box = (node: Element | null) => {
          if (!node) throw new Error("Debug layout target is missing");
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
            centerReachable: hit !== null && (hit === node || node.contains(hit)) };
        };
        return { viewport: { x: 0, y: 0, right: window.innerWidth, bottom: window.innerHeight },
          workspaceHeader: box(document.querySelector("[data-workspace-header]")), contentRow: box(element.parentElement),
          pane: box(element), paneHeader: box(element.querySelector("header")), footer: box(element.querySelector("footer")),
          composer: box(element.querySelector('[role="combobox"]')), send: box(element.querySelector('button[aria-label="Send message"]')) };
      });
      await testInfo.attach(`reference-debug-${viewport.label}-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
      await capture(page, testInfo, `reference-debug-${viewport.label}-before-boundary`);
      const allocated = viewport.compact ? geometry.viewport : geometry.contentRow;
      for (const [name, bounds, container] of [
        ["pane", geometry.pane, allocated],
        ["pane header", geometry.paneHeader, geometry.pane],
        ["footer", geometry.footer, geometry.pane],
        ["composer", geometry.composer, geometry.footer],
        ["Send", geometry.send, geometry.footer],
      ] as const) {
        expect(bounds.width, `${name} must have positive width`).toBeGreaterThan(0);
        expect(bounds.height, `${name} must have positive height`).toBeGreaterThan(0);
        expect(bounds.x, `${name} left within allocated bounds`).toBeGreaterThanOrEqual(container.x);
        expect(bounds.y, `${name} top within allocated bounds`).toBeGreaterThanOrEqual(container.y);
        expect(bounds.right, `${name} right within allocated bounds`).toBeLessThanOrEqual(container.right);
        expect(bounds.bottom, `${name} bottom within allocated bounds`).toBeLessThanOrEqual(container.bottom);
        expect(bounds.bottom, `${name} bottom within viewport`).toBeLessThanOrEqual(geometry.viewport.bottom);
      }
      expect(geometry.workspaceHeader.height).toBe(64);
      expect(geometry.composer.centerReachable).toBe(true);
      expect(geometry.send.centerReachable).toBe(true);
      if (viewport.compact) await composer.tap();
      else await composer.click();
      await expect(composer).toBeFocused();
      const prompt = `Explain this synthetic ${viewport.label} trace.`;
      await composer.fill(prompt);
      await composer.press("Tab");
      await expect(send).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(composer).toBeFocused();
      await composer.press("Tab");
      await expect(send).toBeFocused();
      await expectUnobscured(send);
      const [disabledResponse] = await Promise.all([
        page.waitForResponse(response => response.request().method() === "POST"
          && response.url() === `${runPhantom.url}/api/agent/messages`),
        viewport.compact ? send.tap() : page.keyboard.press("Enter"),
      ]);
      expect(disabledResponse.status()).toBe(409);
      await expect(pane.getByRole("log", { name: "Debug chat messages" })).toContainText(prompt);
      await expect(pane.getByRole("alert")).toBeVisible();
      if (viewport.compact) await composer.tap();
      else await composer.click();
      await expect(composer).toBeFocused();
      await expectUnobscured(composer);
      await expectUnobscured(send);
    });
  });
}
