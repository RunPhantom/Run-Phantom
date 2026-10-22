import { test, expect } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";
import type { Span } from "../src/utils/types";

const faults = new WeakMap<import("@playwright/test").Page, string[]>();
test.beforeEach(async ({ page }) => {
  const observed: string[] = []; faults.set(page, observed);
  page.on("pageerror", error => observed.push(error.message));
  page.on("console", message => { if (message.type() === "error") observed.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400) observed.push(`${response.status()} ${response.url()}`); });
  page.on("requestfailed", request => observed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`));
});
test.afterEach(async ({ page }) => { expect(faults.get(page) ?? []).toEqual([]); faults.delete(page); });

const COMPACT_RUN = "26000000000000000000000000000001";
const spanId = (slot: number) => slot.toString(16).padStart(16, "0");
const ROOT = spanId(1), INVOKE_A = spanId(200), INVOKE_B = spanId(210);

async function seedCompactRun(url: string, overlappingTools = 0): Promise<{ spans: Span[]; subAgents: Array<{ root_span_id: string; span_ids: string[] }> }> {
  const origin = 1_777_000_000_000;
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const otlp = (slot: number, start: number, end: number, parent: number | null, name: string, operation: string, output: string) => ({
    traceId: COMPACT_RUN, spanId: spanId(slot), parentSpanId: parent === null ? undefined : spanId(parent), name,
    startTimeUnixNano: String(BigInt(origin + start) * 1_000_000n), endTimeUnixNano: String(BigInt(origin + end) * 1_000_000n), status: { code: 1 },
    attributes: [attribute("ai.operationId", operation), attribute("ai.telemetry.metadata.runphantom.eventName", "timeline-fixture"),
      ...(operation === "ai.toolCall" ? [attribute("ai.toolCall.name", name), attribute("ai.toolCall.args", '{"prompt":"identical captured prompt"}'), attribute("ai.toolCall.result", output)]
        : [attribute("ai.prompt", '{"messages":[{"role":"user","content":"identical captured prompt"}]}'), attribute("ai.response.text", output), attribute("ai.model.id", "fixture-model")])],
  });
  const spans = [otlp(1, 0, 500, null, "llm.generate", "ai.generateText", "Main captured output"),
    ...Array.from({ length: 100 }, (_, i) => otlp(i + 2, i + 1, i + 2, 1, `serial-tool-${i}`, "ai.toolCall", `serial-result-${i}`)),
    otlp(150, 150, 190, 1, "parallel-tool", "ai.toolCall", "Parallel A"), otlp(151, 150, 190, 1, "parallel-tool", "ai.toolCall", "Parallel B"),
    otlp(200, 240, 300, 1, "reviewAgent", "ai.toolCall", "Invocation A finished"), otlp(201, 245, 260, 200, "agent.subagent", "ai.generateText", "Invocation A first output"), otlp(202, 270, 290, 200, "agent.subagent", "ai.generateText", "Invocation A final output"),
    otlp(210, 340, 400, 1, "reviewAgent", "ai.toolCall", "Invocation B finished"), otlp(211, 345, 360, 210, "agent.subagent", "ai.generateText", "Invocation B first output"), otlp(212, 370, 390, 210, "agent.subagent", "ai.generateText", "Invocation B final output"),
    ...Array.from({ length: overlappingTools }, (_, i) => otlp(400 + i, 0, 500, 1, `touch-overlap-${i}`, "ai.toolCall", `touch-result-${i}`))];
  const response = await fetch(`${url}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }) });
  expect(response.ok, `actual OTLP ingestion returned ${response.status}`).toBe(true);
  const detail = await fetch(`${url}/api/runs/detail/${COMPACT_RUN}`);
  expect(detail.ok).toBe(true);
  return await detail.json();
}

async function screenshot(page: import("@playwright/test").Page, info: import("@playwright/test").TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

type TimelineTouchProbe = { starts: number; moves: number; untrusted: number; singleFinger: boolean; cleanup: () => void };
type ObservedTouchElement = Element & { timelineTouchProbe?: TimelineTouchProbe };

async function scrollWithDeliveredTouch(
  page: import("@playwright/test").Page, touch: import("@playwright/test").CDPSession,
  target: import("@playwright/test").Locator, vertical: import("@playwright/test").Locator,
  direction: "vertical" | "horizontal", info: import("@playwright/test").TestInfo,
) {
  const region = (await vertical.boundingBox())!, box = (await target.boundingBox())!, viewport = page.viewportSize()!;
  expect(region).not.toBeNull(); expect(box).not.toBeNull(); expect(viewport).not.toBeNull();
  const visibleClientRect = (element: Element) => {
    const clientRect = (node: Element) => {
      const rect = node.getBoundingClientRect();
      const left = rect.left + node.clientLeft, top = rect.top + node.clientTop;
      return { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight };
    };
    const visible = clientRect(element);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), clip = clientRect(parent);
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
        visible.left = Math.max(visible.left, clip.left); visible.right = Math.min(visible.right, clip.right);
      }
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
        visible.top = Math.max(visible.top, clip.top); visible.bottom = Math.min(visible.bottom, clip.bottom);
      }
    }
    return visible;
  };
  const [visibleRegion, visibleBox] = await Promise.all([vertical.evaluate(visibleClientRect), target.evaluate(visibleClientRect)]);
  const left = Math.max(0, visibleRegion.left, visibleBox.left) + 24, right = Math.min(viewport.width, visibleRegion.right, visibleBox.right) - 24;
  const top = Math.max(0, visibleRegion.top, visibleBox.top) + 24, bottom = Math.min(viewport.height, visibleRegion.bottom, visibleBox.bottom) - 24;
  expect(right - left).toBeGreaterThan(32); expect(bottom - top).toBeGreaterThan(32);
  const start = direction === "vertical" ? { x: left, y: bottom } : { x: right, y: top };
  const end = direction === "vertical" ? { x: start.x, y: Math.max(top, start.y - 120) } : { x: Math.max(left, start.x - 120), y: start.y };
  const points = Array.from({ length: 13 }, (_, step) => ({ x: start.x + (end.x - start.x) * step / 12, y: start.y + (end.y - start.y) * step / 12 }));
  expect(await target.evaluate((element, points) => points.every(point => {
    const hit = document.elementFromPoint(point.x, point.y);
    return hit !== null && element.contains(hit);
  }), points)).toBe(true);
  const before = await target.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }));
  await target.evaluate(element => {
    const probe: TimelineTouchProbe = { starts: 0, moves: 0, untrusted: 0, singleFinger: true, cleanup: () => {
      element.removeEventListener("touchstart", observe); element.removeEventListener("touchmove", observe);
    } };
    function observe(event: Event) {
      if (!(event instanceof TouchEvent)) return;
      if (!event.isTrusted) probe.untrusted++;
      if (event.touches.length !== 1) probe.singleFinger = false;
      if (event.type === "touchstart") probe.starts++;
      if (event.type === "touchmove") probe.moves++;
    }
    element.addEventListener("touchstart", observe, { passive: true });
    element.addEventListener("touchmove", observe, { passive: true });
    (element as ObservedTouchElement).timelineTouchProbe = probe;
  });
  let receipt;
  try {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
    for (const point of points.slice(1)) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
      // Advance browser frames so the gesture reaches default scrolling rather than a synchronous input burst.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    }
  } finally {
    try { await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); }
    finally {
      receipt = await target.evaluate(element => {
        const probe = (element as ObservedTouchElement).timelineTouchProbe!;
        probe.cleanup(); delete (element as ObservedTouchElement).timelineTouchProbe;
        return { starts: probe.starts, moves: probe.moves, untrusted: probe.untrusted, singleFinger: probe.singleFinger };
      });
    }
  }
  expect(receipt.starts).toBe(1); expect(receipt.moves).toBeGreaterThan(0);
  expect(receipt.untrusted).toBe(0); expect(receipt.singleFinger).toBe(true);
  await info.attach(`delivered-touch-${direction}-${viewport.width}`, { contentType: "application/json", body: JSON.stringify({
    source: "CDP single-finger browser input", direction, region, box, visibleRegion, visibleBox, viewport, start, end, hitTestedPoints: points.length,
    receipt, before, after: await target.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft })),
  }) });
}

test("timeline baseline: exact span population, tool action and captured output survive layout work", async ({ page, request, runPhantom }, testInfo) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
  const response = await request.get(detailUrl);
  expect(response.ok()).toBe(true);
  const before = await response.json() as { spans: Span[] };
  const eligible = before.spans.filter(span => span.span_type === "TRACE" || span.span_type === "TOOL_CALL" || span.span_type?.includes("LLM"));
  const tool = eligible.find(span => span.span_type === "TOOL_CALL")!;
  expect(tool.output_payload).toBeTruthy();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const bars = page.locator('button.timeline-bar, button[aria-label^="Jump to "]');
  await expect(bars).toHaveCount(eligible.length);
  const bar = page.locator(`button[data-meridian-key="${tool.id}"]`).first();
  await bar.scrollIntoViewIfNeeded();
  await bar.hover();
  await expect(page.locator("[data-span-tooltip]")).toContainText(tool.name);
  await bar.click();
  const pill = page.locator(`[data-tool-span-id="${tool.id}"]`);
  await expect(pill.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(pill).toContainText("A traec viewer for AI agents.");
  await page.mouse.move(2, 2);
  await expect(page.locator("[data-span-tooltip]")).toBeHidden();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await bars.first().scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    const screenshot = testInfo.outputPath(`timeline-preserved-${viewport.width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`timeline-preserved-${viewport.width}`, { path: screenshot, contentType: "image/png" });
  }
  expect((await (await request.get(detailUrl)).json()).spans).toEqual(before.spans);
  expect(errors).toEqual([]);
});

test("compact timeline: actual serial spans pack, equal-name overlaps separate and legacy population is retained", async ({ page, request, runPhantom }, info) => {
  const before = await seedCompactRun(runPhantom.url);
  expect(before.spans).toHaveLength(109);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${COMPACT_RUN}`);
  const timeline = page.locator("[data-trace-timeline]");
  await expect(timeline).toHaveAttribute("data-layout", "named");
  const bars = timeline.locator("[data-timeline-span-id]");
  await expect(bars).toHaveCount(before.spans.length);
  await timeline.getByRole("button", { name: "Compact layout", exact: true }).click();
  await expect(timeline).toHaveAttribute("data-layout", "compact");
  const rows = await bars.evaluateAll(elements => Object.fromEntries(elements.map(element => [element.getAttribute("data-timeline-span-id")!, element.getAttribute("data-timeline-row")])));
  expect(new Set(Array.from({ length: 100 }, (_, i) => rows[spanId(i + 2)]))).toEqual(new Set(["1"]));
  expect(rows[spanId(150)]).not.toBe(rows[spanId(151)]);
  expect(Number(rows[INVOKE_A])).toBeGreaterThan(Number(rows[ROOT]));
  expect(Number(rows[spanId(201)])).toBeGreaterThan(Number(rows[INVOKE_A]));
  const serialRects = await bars.evaluateAll((elements, ids) => elements.filter(element => ids.includes(element.getAttribute("data-timeline-span-id")!)).map(element => {
    const box = element.getBoundingClientRect(); return { left: box.left, right: box.right };
  }).sort((a, b) => a.left - b.left), Array.from({ length: 100 }, (_, i) => spanId(i + 2)));
  expect(serialRects).toHaveLength(100);
  expect(serialRects.every((rect, index) => index === 0 || rect.left >= serialRects[index - 1].right - 0.05)).toBe(true);
  const ids = await bars.evaluateAll(elements => elements.map(element => element.getAttribute("data-timeline-span-id")));
  expect(ids.sort()).toEqual(before.spans.map(span => span.id).sort());
  await timeline.scrollIntoViewIfNeeded();
  await screenshot(page, info, "compact-serial-desktop");
  await timeline.getByRole("button", { name: "Compact layout", exact: true }).click();
  await expect(timeline).toHaveAttribute("data-layout", "named");
  await expect(bars).toHaveCount(109);
  expect((await (await request.get(`${runPhantom.url}/api/runs/detail/${COMPACT_RUN}`)).json()).spans).toEqual(before.spans);
  expect(errors).toEqual([]);
});

test("compact timeline: two equal-prompt invocations open only their real captured identity", async ({ page, request, runPhantom }, info) => {
  const before = await seedCompactRun(runPhantom.url);
  expect(before.subAgents.map(agent => agent.root_span_id).sort()).toEqual([INVOKE_A, INVOKE_B]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${runPhantom.url}/runs/${COMPACT_RUN}`);
  const timeline = page.locator("[data-trace-timeline]");
  await timeline.getByRole("button", { name: "Compact layout", exact: true }).click();
  const invocations = timeline.locator('div[aria-label="Captured agent invocations"] button');
  await expect(invocations).toHaveCount(2);
  await timeline.locator(`button[data-invocation-root="${INVOKE_B}"]`).first().click();
  await expect(page.getByText("Invocation B first output", { exact: true })).toBeVisible();
  await expect(page.getByText("Invocation B final output", { exact: true })).toBeVisible();
  await expect(page.getByText("Invocation A final output", { exact: true })).toHaveCount(0);
  await screenshot(page, info, "compact-exact-invocation-b");
  expect((await (await request.get(`${runPhantom.url}/api/runs/detail/${COMPACT_RUN}`)).json()).spans).toEqual(before.spans);
});

test("compact timeline: exact tool expansion and keyboard span deep link retain captured outputs after reload", async ({ page, request, runPhantom }, info) => {
  const before = await seedCompactRun(runPhantom.url);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${runPhantom.url}/runs/${COMPACT_RUN}`);
  const timeline = page.locator("[data-trace-timeline]");
  await timeline.getByRole("button", { name: "Compact layout", exact: true }).click();
  const tool = timeline.locator(`[data-timeline-span-id="${spanId(101)}"]`);
  await tool.scrollIntoViewIfNeeded(); await tool.click();
  const pill = page.locator(`[data-tool-span-id="${spanId(101)}"]`);
  await expect(pill.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(pill).toContainText("serial-result-99");
  await tool.hover();
  const closeDetails = page.getByRole("button", { name: "Close span details", exact: true });
  await closeDetails.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-span-tooltip]")).toBeHidden();
  await expect(tool).toBeFocused();
  await page.mouse.move(2, 2); await expect(page.locator("[data-span-tooltip]")).toBeHidden();
  const open = timeline.getByRole("button", { name: "Open selected span in tree", exact: true });
  await open.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(open).toBeFocused();
  expect(await open.evaluate(element => { const style = getComputedStyle(element); return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2; })).toBe(true);
  await screenshot(page, info, "compact-keyboard-selection");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/runs/${COMPACT_RUN}/span/${spanId(101)}$`));
  await expect(page.getByText("serial-result-99", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("serial-result-99", { exact: true }).first()).toBeVisible();
  expect((await (await request.get(`${runPhantom.url}/api/runs/detail/${COMPACT_RUN}`)).json()).spans).toEqual(before.spans);
});

test("compact timeline: Escape on the genuine focused bar dismisses details and retains its exact action", async ({ page, request, runPhantom }, info) => {
  const before = await seedCompactRun(runPhantom.url);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${COMPACT_RUN}`);
  const timeline = page.locator("[data-trace-timeline]");
  await timeline.getByRole("button", { name: "Compact layout", exact: true }).click();
  const tool = timeline.locator(`[data-timeline-span-id="${spanId(101)}"]`);
  await tool.scrollIntoViewIfNeeded();
  await tool.focus();
  await expect(tool).toBeFocused();
  await expect(page.locator("[data-span-tooltip]")).toContainText("serial-result-99");
  await screenshot(page, info, "compact-focused-trigger-details");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-span-tooltip]")).toBeHidden({ timeout: 1_500 });
  await expect(tool).toBeFocused();
  expect(await tool.evaluate(element => { const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return hit !== null && element.contains(hit); })).toBe(true);
  await screenshot(page, info, "compact-focused-trigger-dismissed");
  await page.keyboard.press("Enter");
  const pill = page.locator(`[data-tool-span-id="${spanId(101)}"]`);
  await expect(pill.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(pill).toContainText("serial-result-99");
  expect((await (await request.get(`${runPhantom.url}/api/runs/detail/${COMPACT_RUN}`)).json()).spans).toEqual(before.spans);
});

test("compact timeline: Escape dismisses hovered details from unrelated focus while passive leave preserves that focus", async ({ page, request, runPhantom }, info) => {
  const before = await seedCompactRun(runPhantom.url);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${COMPACT_RUN}`);
  const timeline = page.locator("[data-trace-timeline]");
  const compact = timeline.getByRole("button", { name: "Compact layout", exact: true });
  await compact.click();
  await compact.focus();
  const tool = timeline.locator(`[data-timeline-span-id="${spanId(150)}"]`);
  await tool.hover();
  await expect(compact).toBeFocused();
  await expect(page.locator("[data-span-tooltip]")).toContainText("Parallel A");
  await screenshot(page, info, "compact-hover-unrelated-focus-details");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-span-tooltip]")).toBeHidden({ timeout: 1_500 });
  await expect(tool).toBeFocused();
  expect(await tool.evaluate(element => { const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return hit !== null && element.contains(hit); })).toBe(true);
  await screenshot(page, info, "compact-hover-escape-restored-trigger");
  await compact.focus();
  const other = timeline.locator(`[data-timeline-span-id="${spanId(151)}"]`);
  await other.hover();
  await expect(compact).toBeFocused();
  await expect(page.locator("[data-span-tooltip]")).toContainText("Parallel B");
  await page.mouse.move(2, 2);
  await expect(page.locator("[data-span-tooltip]")).toBeHidden();
  await expect(compact).toBeFocused();
  await screenshot(page, info, "compact-passive-leave-keeps-unrelated-focus");
  expect((await (await request.get(`${runPhantom.url}/api/runs/detail/${COMPACT_RUN}`)).json()).spans).toEqual(before.spans);
});

test("compact timeline: responsive time-axis scrolling stays local and controls remain visible", async ({ page, runPhantom }, info) => {
  await seedCompactRun(runPhantom.url);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${runPhantom.url}/runs/${COMPACT_RUN}`);
    const timeline = page.locator("[data-trace-timeline]");
    const compact = timeline.getByRole("button", { name: "Compact layout", exact: true });
    await compact.click();
    await expect(compact).toHaveAttribute("aria-pressed", "true");
    await timeline.scrollIntoViewIfNeeded();
    const axis = timeline.getByRole("region", { name: "Trace time axis", exact: true });
    if (viewport.width <= 768) {
      expect(await axis.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await axis.focus(); await page.keyboard.press("ArrowRight");
      await expect.poll(() => axis.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    }
    if (viewport.width <= 360) {
      const vertical = timeline.getByRole("region", { name: "Trace timeline", exact: true });
      expect(await vertical.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      await vertical.focus(); await page.keyboard.press("End");
      await expect.poll(() => vertical.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      const last = timeline.locator(`[data-timeline-span-id="${spanId(212)}"]`);
      await last.scrollIntoViewIfNeeded();
      expect(await last.evaluate(element => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return hit !== null && element.contains(hit); })).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    const rect = await timeline.boundingBox(); expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width);
    await timeline.evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
    await screenshot(page, info, `compact-responsive-${viewport.width}`);
  }
});

test("compact timeline: actual orphan, cyclic and missing timestamp captures retain explicit coverage and outputs", async ({ page, request, runPhantom }, info) => {
  await seedCompactRun(runPhantom.url);
  const origin = 1_777_000_000_000;
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const topology = (slot: number, parent: number | null, start: number, end: number | null, name: string, isError = false) => ({
    traceId: COMPACT_RUN, spanId: spanId(slot), parentSpanId: parent === null ? undefined : spanId(parent), name,
    startTimeUnixNano: String(BigInt(start) * 1_000_000n), ...(end === null ? {} : { endTimeUnixNano: String(BigInt(end) * 1_000_000n) }),
    status: { code: isError ? 2 : end === null || start === 0 ? 0 : 1 },
    attributes: [attribute("ai.operationId", "ai.toolCall"), attribute("ai.toolCall.name", name), attribute("ai.toolCall.result", `${name} captured output`), attribute("ai.telemetry.metadata.runphantom.eventName", "timeline-fixture")],
  });
  const additional = [topology(301, 999, origin + 105, origin + 110, "orphan-tool"), topology(302, 303, origin + 110, origin + 115, "cyclic-a"), topology(303, 302, origin + 110, origin + 115, "cyclic-b"), topology(304, 1, 0, 0, "absent-time"), topology(305, 1, origin + 410, null, "missing-end"), topology(306, 1, origin + 105, origin + 106, "error-tool", true), topology(307, 1, origin + 106, origin + 107, "error-tool", true)];
  const ingest = await request.post(`${runPhantom.url}/v1/traces`, { data: { resourceSpans: [{ scopeSpans: [{ spans: additional }] }] } });
  expect(ingest.ok()).toBe(true);
  const detailUrl = `${runPhantom.url}/api/runs/detail/${COMPACT_RUN}`;
  const before = await (await request.get(detailUrl)).json() as { spans: Span[] };
  expect(before.spans).toHaveLength(116);
  expect(before.spans.find(span => span.id === spanId(305))!.end_time_ms).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${runPhantom.url}/runs/${COMPACT_RUN}`);
  const timeline = page.locator("[data-trace-timeline]");
  await timeline.getByRole("button", { name: "Compact layout", exact: true }).click();
  await expect(timeline.locator("[data-timeline-span-id]")).toHaveCount(116);
  const errorRects = await timeline.locator(`[data-timeline-span-id="${spanId(306)}"], [data-timeline-span-id="${spanId(307)}"]`).evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  expect(errorRects).toHaveLength(2);
  expect(errorRects[0].right <= errorRects[1].left + 0.05 || errorRects[1].right <= errorRects[0].left + 0.05 || errorRects[0].bottom <= errorRects[1].top || errorRects[1].bottom <= errorRects[0].top).toBe(true);
  const errorBar = timeline.locator(`[data-timeline-span-id="${spanId(306)}"]`);
  await errorBar.scrollIntoViewIfNeeded();
  expect(await errorBar.evaluate(element => { const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return hit !== null && element.contains(hit); })).toBe(true);
  await screenshot(page, info, "compact-reachable-error-markers");
  await errorBar.click();
  const errorPill = page.locator(`[data-tool-span-id="${spanId(306)}"]`);
  await expect(errorPill.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(errorPill).toContainText("error-tool captured output");
  await page.mouse.move(2, 2); await expect(page.locator("[data-span-tooltip]")).toBeHidden();
  const coverage = timeline.locator("[data-timeline-coverage]");
  await expect(coverage).toContainText("2 spans with time unavailable");
  await expect(coverage).toContainText("2 cyclic parent links not drawn");
  await expect(coverage).toContainText("1 parent link outside this timeline or unavailable");
  const absent = timeline.locator(`[data-timeline-span-id="${spanId(304)}"]`);
  await expect(absent).toHaveAccessibleName("Inspect absent-time, time unavailable");
  await absent.scrollIntoViewIfNeeded(); await absent.click();
  const pill = page.locator(`[data-tool-span-id="${spanId(304)}"]`);
  await expect(pill).toContainText("absent-time captured output");
  await page.mouse.move(2, 2); await expect(page.locator("[data-span-tooltip]")).toBeHidden();
  await timeline.scrollIntoViewIfNeeded();
  await screenshot(page, info, "compact-unavailable-coverage");
  expect((await (await request.get(detailUrl)).json()).spans).toEqual(before.spans);
});

test.describe("compact timeline touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("a real coarse-pointer context scrolls lower rows locally and opens the captured invocation", async ({ page, request, runPhantom }, info) => {
    const before = await seedCompactRun(runPhantom.url, 16);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const touch = await page.context().newCDPSession(page);
    try {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 740 });
        await page.goto(`${runPhantom.url}/runs/${COMPACT_RUN}`);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        const timeline = page.locator("[data-trace-timeline]");
        const compact = timeline.getByRole("button", { name: "Compact layout", exact: true });
        expect((await compact.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await compact.tap();
        await expect(timeline.locator("[data-timeline-span-id]")).toHaveCount(125);
        const invocation = timeline.locator(`button[data-invocation-root="${INVOKE_A}"]`).first();
        expect((await invocation.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const vertical = timeline.getByRole("region", { name: "Trace timeline", exact: true });
        await vertical.scrollIntoViewIfNeeded();
        expect(await vertical.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        const ancestorOffsets = () => vertical.evaluate(element => {
          const offsets: number[] = [];
          for (let parent = element.parentElement; parent; parent = parent.parentElement) offsets.push(parent.scrollTop);
          return offsets;
        });
        const beforeOffsets = await ancestorOffsets();
        await scrollWithDeliveredTouch(page, touch, vertical, vertical, "vertical", info);
        await expect.poll(() => vertical.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        expect(await ancestorOffsets()).toEqual(beforeOffsets);
        const axis = timeline.getByRole("region", { name: "Trace time axis", exact: true });
        await scrollWithDeliveredTouch(page, touch, axis, vertical, "horizontal", info);
        await expect.poll(() => axis.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        const last = timeline.locator(`[data-timeline-span-id="${spanId(212)}"]`);
        await last.scrollIntoViewIfNeeded();
        expect(await last.evaluate(element => { const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return hit !== null && element.contains(hit); })).toBe(true);
        await last.tap();
        await expect(timeline.getByRole("button", { name: "Open selected span in tree", exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await expect(page.locator("[data-span-tooltip]")).toContainText("Invocation B final output");
        await screenshot(page, info, `compact-coarse-pointer-details-${width}`);
        const closeDetails = page.getByRole("button", { name: "Close span details", exact: true });
        const closeBox = (await closeDetails.boundingBox())!;
        expect(closeBox.height).toBeGreaterThanOrEqual(44); expect(closeBox.width).toBeGreaterThanOrEqual(44);
        await closeDetails.tap();
        await expect(page.locator("[data-span-tooltip]")).toBeHidden();
        await expect(last).toBeFocused();
        expect(await last.evaluate(element => { const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return hit !== null && element.contains(hit); })).toBe(true);
        await screenshot(page, info, `compact-coarse-pointer-${width}`);
        await invocation.tap();
        await expect(page.getByText("Invocation A final output", { exact: true })).toBeVisible();
        await expect(page.getByText("Invocation B final output", { exact: true })).toHaveCount(0);
        expect((await (await request.get(`${runPhantom.url}/api/runs/detail/${COMPACT_RUN}`)).json()).spans).toEqual(before.spans);
      }
    } finally {
      await touch.detach();
    }
  });
});
