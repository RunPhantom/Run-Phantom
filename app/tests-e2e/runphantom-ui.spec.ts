import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import {
  clearRunPhantom,
  expectRunPhantomBranding,
  FIXTURE_DISPLAY_NAME,
  FIXTURE_LIVE_RUN_ID,
  FIXTURE_PRIMARY_RUN_ID,
  FIXTURE_SAVED_SIBLING_RUN_ID,
  FIXTURE_SPAN_COUNT,
  hasLegacyIdentityKey,
  headerSeparatorProblems,
  listRunPhantomRuns,
  readLocalStorageKeys,
  readRunPhantomRun,
  readRunPhantomSpans,
  saveRunPhantomRun,
  seedRunPhantomFixtures,
} from "./helpers";

test.beforeEach(async ({ runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
});

test("Run Phantom UI: clean-break branding and setup state use Run Phantom keys", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(runPhantom.url);
  await expectRunPhantomBranding(page);
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("runphantom:firstTimeSetupDismissed")), {
      timeout: 10_000,
    })
    .toBe("1");

  const localStorageKeys = await readLocalStorageKeys(page);
  expect(hasLegacyIdentityKey(localStorageKeys)).toBe(false);
});

test("Run Phantom UI: initial runs view avoids optional-provider request failures", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const failingResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    failingResponses.push({ url: url.pathname, status: response.status() });
  });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  expect(failingResponses).toEqual([]);
});

test("Run Phantom UI: mobile layout exposes a visible sidebar toggle", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.setViewportSize({ width: 430, height: 932 });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  const sidebarToggle = page.getByRole("button", { name: /toggle sidebar/i });
  await expect(sidebarToggle).toBeVisible({ timeout: 10_000 });
  await sidebarToggle.click();
  await expect(page.getByRole("link", { name: /^search$/i })).toBeVisible({ timeout: 5_000 });
});

test("Run Phantom UI: mobile viewport keeps the runs list usable when chat is expanded", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("runphantom:messagePane:collapsed", "0");
    localStorage.setItem("runphantom:messagePane:width", "460");
  });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  const row = page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const box = await row.boundingBox();
  expect(box, "expected the primary run row to render in the mobile list").not.toBeNull();
  expect(box!.width, "mobile chat must not squeeze the runs list below a usable width").toBeGreaterThan(300);
});

test("Run Phantom UI: clear button empties runs list and database", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const before = await listRunPhantomRuns(runPhantom.url);
  expect(before.length).toBeGreaterThanOrEqual(3);

  await page.goto(runPhantom.url);
  page.on("dialog", (dialog) => dialog.accept());

  const clearButton = page.getByRole("button", { name: /^clear all runs$/i });
  await expect(clearButton).toBeVisible({ timeout: 10_000 });
  await clearButton.click();

  await expect.poll(async () => (await listRunPhantomRuns(runPhantom.url)).length, {
    timeout: 10_000,
  }).toBe(0);
});

test("Run Phantom UI: seeded runs appear live without a reload", async ({ page, runPhantom }) => {
  await page.goto(runPhantom.url);
  await expect(page.getByText(/no runs/i).first()).toBeVisible({ timeout: 10_000 });

  await seedRunPhantomFixtures(runPhantom.url);

  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`[data-run-id="${FIXTURE_LIVE_RUN_ID}"]`)).toBeVisible({ timeout: 10_000 });
});

test("Run Phantom UI: local search filters seeded runs", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/search`);
  await expectRunPhantomBranding(page);

  const searchField = page.getByPlaceholder("Search by title, event, user, conversation, or id");
  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible({ timeout: 10_000 });

  await searchField.fill("definitely-not-a-real-event-name-xyz");
  await expect(page.getByText(/no matching runs/i)).toBeVisible({ timeout: 5_000 });

  await searchField.fill(FIXTURE_DISPLAY_NAME);
  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible({ timeout: 5_000 });
  await page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/search/${FIXTURE_PRIMARY_RUN_ID}(?:[/?#]|$)`));
});

test("Run Phantom UI: span tree and side panel render the seeded trace", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const run = await readRunPhantomRun(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);
  expect(run, `expected seeded run ${FIXTURE_PRIMARY_RUN_ID} in the database`).not.toBeNull();

  const spans = await readRunPhantomSpans(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);
  expect(spans.length).toBe(FIXTURE_SPAN_COUNT);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByText(run!.event_name ?? FIXTURE_PRIMARY_RUN_ID).first()).toBeVisible({ timeout: 10_000 });

  const overviewTab = page.getByRole("tab", { name: "Overview" });
  const spansTab = page.getByRole("tab", { name: "Span Tree" });
  await expect(spansTab).toBeVisible({ timeout: 10_000 });
  await overviewTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(spansTab).toBeFocused();
  await expect(spansTab).toHaveAttribute("aria-selected", "true");
  const rows = page.locator("[data-span-row]");
  await expect.poll(async () => rows.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(FIXTURE_SPAN_COUNT);
  for (const span of spans) {
    await expect(page.locator(`[data-span-row="${span.id}"]`)).toBeVisible({ timeout: 5_000 });
  }

  const detailSpan = spans.find((span) => span.input_payload && span.output_payload);
  expect(detailSpan, "expected one seeded span with both input and output payloads").toBeTruthy();
  const detailRow = page.locator(`[data-span-row="${detailSpan!.id}"]`);
  await detailRow.focus();
  await page.keyboard.press("Shift+F10");
  const annotationMenu = page.getByRole("menu", { name: "Annotate span" });
  await expect(annotationMenu).toBeVisible();
  await expect(annotationMenu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(annotationMenu.getByRole("menuitem", { name: "Add note…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(annotationMenu).toBeHidden();

  await detailRow.click();
  await expect(page).toHaveURL(new RegExp(`/span/${detailSpan!.id}(?:[/?#]|$)`));
  await expect(page.getByText(/^Input$/).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/^Output$/).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/Fix the typo in README\.md/).first()).toBeVisible({ timeout: 5_000 });
});

test("Run Phantom UI: run ids get their own row under the run stats", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  // The ids shared one wrapping row with the stats, joined by a separator. At
  // 1280x720 they wrapped to a second line and left that separator dangling at
  // the end of the first ("TOKENS 4,936 in / 428 out ·").
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);

    const stats = page.locator(".rp-meta-metrics");
    const ids = page.locator(".rp-meta-ids");
    await expect(stats.getByText("tokens", { exact: true })).toBeVisible({ timeout: 10_000 });
    for (const label of ["user", "conversation", "trace"]) {
      await expect(ids.getByRole("button", { name: `Copy ${label}` })).toBeVisible();
    }
    const statsBox = (await stats.boundingBox())!;
    const idsBox = (await ids.boundingBox())!;
    expect(idsBox.y, `the ids start below the stats at ${viewport.width}px`).toBeGreaterThanOrEqual(statsBox.y + statsBox.height);
    expect(Math.abs(idsBox.x - statsBox.x), `the ids line up with the stats at ${viewport.width}px`).toBeLessThanOrEqual(1);
    await expect.poll(() => headerSeparatorProblems(page), { message: `separators at ${viewport.width}px` }).toEqual([]);
  }
});

test("Run Phantom UI: wrapped run stats never end a line with a separator", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.addInitScript(() => {
    localStorage.setItem("runphantom:messagePane:collapsed", "0");
    localStorage.setItem("runphantom:messagePane:width", "460");
  });

  // With the side pane open at 1280x720 the stats wrap, and each separator was
  // a flex item of its own: the one before TOKENS stayed behind at the end of
  // the first line ("DURATION 3s ·").
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const stats = page.locator(".rp-meta-metrics");
  await expect(stats.getByText("tokens", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect((await stats.boundingBox())!.height, "the stats wrap beside the side pane").toBeGreaterThan(30);
  await expect.poll(() => headerSeparatorProblems(page)).toEqual([]);
});

test("Run Phantom UI: run ids wrap whole beside the side pane", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.addInitScript(() => {
    localStorage.setItem("runphantom:messagePane:collapsed", "0");
    localStorage.setItem("runphantom:messagePane:width", "460");
  });

  // The ids row could not wrap, so beside the side pane it squeezed the ids
  // instead: "demo-user" broke across two lines, and an id with no break
  // point pushed the next label into it ("conv_71d3e9TRACE").
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const ids = page.locator(".rp-meta-ids");
  await expect(ids.getByRole("button", { name: "Copy trace" })).toBeVisible({ timeout: 10_000 });
  const layout = await ids.evaluate((row) => ({
    pairs: [...row.children].map((pair) => ({ text: pair.textContent, height: pair.getBoundingClientRect().height })),
    squeezedLabels: [...row.querySelectorAll(".rp-meta-copy")].filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent),
  }));
  expect(layout.pairs).toHaveLength(3);
  for (const pair of layout.pairs) expect(pair.height, `"${pair.text}" stays on one line`).toBeLessThanOrEqual(24.5);
  expect(layout.squeezedLabels).toEqual([]);
});

test("Run Phantom UI: run header actions never cover the run title or status", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  // The actions group used to be flex-shrink-0 beside a shrinkable title, so at
  // common laptop widths it overflowed leftwards across the status chip and
  // squeezed the title to nothing.
  for (const viewport of [{ width: 1024, height: 720 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);

    const header = page.locator("[data-run-header]");
    const status = header.locator("[data-run-status]");
    await expect(status).toHaveText(/^Run (?:live|failed|complete)$/, { timeout: 10_000 });
    const actions = header.locator("[data-run-actions]");
    await expect(actions.getByRole("button", { name: "Annotate" })).toBeVisible();

    const title = status.locator("xpath=preceding-sibling::*[1]");
    const titleWidth = await title.evaluate((element) => element.getBoundingClientRect().width);
    expect(titleWidth, `title width at ${viewport.width}px`).toBeGreaterThanOrEqual(48);

    const statusBox = (await status.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    const controlBoxes = await actions.locator(":scope > button, :scope > a, :scope > div").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.textContent?.trim() || element.getAttribute("aria-label") || "", x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }).filter((box) => box.width > 0 && box.height > 0),
    );
    expect(controlBoxes.length).toBeGreaterThan(0);
    for (const control of controlBoxes) {
      expect(overlaps(control, statusBox), `"${control.label}" covers the status at ${viewport.width}px`).toBe(false);
      expect(overlaps(control, titleBox), `"${control.label}" covers the title at ${viewport.width}px`).toBe(false);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `horizontal overflow at ${viewport.width}px`).toBe(viewport.width);
  }
});

test("Run Phantom UI: Debug opens the chat with its header in a fresh profile", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  // A fresh profile has never dismissed the coding-agent intro. Debug opened the
  // chat view anyway, and that view took the intro's layout: no header, and the
  // intro's floating "Hide" button drawn over the first message.
  expect(await page.evaluate(() => localStorage.getItem("runphantom:messagePane:providerIntroSeen"))).toBeNull();

  await page.getByRole("button", { name: "Debug", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "Coding-agent debug chat" });
  const prompt = "What went wrong here?";
  await pane.getByRole("button", { name: prompt, exact: true }).click();
  const firstMessage = pane.getByRole("log", { name: "Debug chat messages" }).locator(":scope > *").first().locator(":scope > *");
  await expect(firstMessage).toHaveText(prompt);

  const covering = await firstMessage.evaluate((message) => {
    const box = message.getBoundingClientRect();
    return Array.from(message.closest("aside")!.querySelectorAll("button"))
      .filter((button) => !message.contains(button))
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.left < box.right && box.left < rect.right && rect.top < box.bottom && box.top < rect.bottom;
      })
      .map((button) => button.getAttribute("aria-label") || button.textContent?.trim() || "");
  });
  expect(covering, "buttons drawn over the first message").toEqual([]);

  const header = pane.locator("header");
  await expect(header).toBeVisible();
  for (const name of ["All Chats", "New chat", "Hide chat"]) {
    await expect(header.getByRole("button", { name, exact: true })).toBeVisible();
  }
  // The header is stacked above the intro's Hide button, so a Hide left in the
  // chat view is out of sight but still reachable by keyboard and screen reader.
  await expect(pane.getByRole("button", { name: "Hide", exact: true }), "intro Hide button left in the chat view").toHaveCount(0);
  const headerBox = (await header.boundingBox())!;
  const messageBox = (await firstMessage.boundingBox())!;
  expect(headerBox.y + headerBox.height, "header ends above the first message").toBeLessThanOrEqual(messageBox.y);

  // The intro still belongs to the floating button's first open, which has no
  // header, so that screen keeps its own Hide control.
  await header.getByRole("button", { name: "Hide chat", exact: true }).click();
  await page.getByRole("button", { name: "Ask Claude Code", exact: true }).click();
  await expect(pane.getByText("Connect your coding agent", { exact: true })).toBeVisible();
  await pane.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(pane).toBeHidden();
});

test("Run Phantom UI: trajectory renders when the first spans arrive after live activity", async ({ page, request, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
  const detail = await (await request.get(detailUrl)).json();
  const expectedBars = detail.spans.filter((span: { span_type: string | null }) =>
    span.span_type === "TRACE" || span.span_type === "TOOL_CALL" || span.span_type?.includes("LLM"),
  ).length;
  expect(expectedBars).toBeGreaterThan(0);

  let spansArrived = false;
  const activity = "Waiting for the first completed span.";
  await page.route(detailUrl, async (route) => {
    if (spansArrived) return route.continue();
    await route.fulfill({ json: {
      ...detail,
      spans: [],
      subAgents: [],
      liveEvents: [{ id: 1, trace_id: FIXTURE_PRIMARY_RUN_ID, span_id: null, type: "reasoning",
        content: activity, timestamp: detail.run.started_at, metadata: null }],
    } });
  });
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByText(activity, { exact: true })).toBeVisible();
  const bars = page.locator('button.timeline-bar, button[aria-label^="Jump to "]');
  await expect(bars).toHaveCount(0);

  // Ingesting the completed spans refreshes the already-mounted overview over
  // its real WebSocket, without a navigation or remount hiding the transition.
  spansArrived = true;
  await seedRunPhantomFixtures(runPhantom.url);
  await expect(bars).toHaveCount(expectedBars);
});

test("Run Phantom UI: a trajectory tooltip never covers the bar it describes", async ({ page, runPhantom }) => {
  const replay = await fetch(`${runPhantom.url}/api/demo-traces/replay`, { method: "POST" });
  expect(replay.ok).toBe(true);
  // All seven bars exist before the final LLM duration arrives. Placement is a
  // completed-snapshot contract; wait before navigation so live updates cannot
  // move the hovered bar out from under the pointer during measurement.
  await expect.poll(async () => {
    const response = await fetch(`${runPhantom.url}/api/runs/detail/demo_review`);
    if (response.status === 404) return 0;
    expect(response.ok).toBe(true);
    const detail = await response.json() as { run: { finished?: number | null } };
    return detail.run.finished;
  }, { timeout: 20_000 }).toBe(1);

  // The tooltip is up to 480px tall. When it fit neither below nor above the bar
  // it was clamped to the top of the viewport, over the bar, so the bar could no
  // longer be clicked while its own tooltip was open.
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1024, height: 640 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${runPhantom.url}/runs/demo_review`);
    await expect(page.locator("[data-run-status]")).toHaveText(/^Run (?:live|failed)$/, { timeout: 20_000 });

    // Retain the exact bar-count check on the completed snapshot. Narrow error
    // spans render as a triangle button instead of a labelled bar.
    const bars = page.locator('button.timeline-bar, button[aria-label^="Jump to "]');
    await expect.poll(async () => bars.count(), { timeout: 20_000 }).toBe(7);
    const count = await bars.count();
    for (let index = 0; index < count; index++) {
      const bar = bars.nth(index);
      await bar.scrollIntoViewIfNeeded();
      await bar.hover();
      const tooltip = page.locator("[data-span-tooltip]");
      await expect(tooltip).toBeVisible();
      const barBox = (await bar.boundingBox())!;
      const tipBox = (await tooltip.boundingBox())!;
      const label = `${await bar.getAttribute("aria-label")} at ${viewport.width}x${viewport.height}`;
      const intersects = barBox.x < tipBox.x + tipBox.width && tipBox.x < barBox.x + barBox.width
        && barBox.y < tipBox.y + tipBox.height && tipBox.y < barBox.y + barBox.height;
      expect(intersects, `tooltip covers ${label}`).toBe(false);
      expect(tipBox.y, `tooltip top inside viewport for ${label}`).toBeGreaterThanOrEqual(0);
      expect(tipBox.y + tipBox.height, `tooltip bottom inside viewport for ${label}`).toBeLessThanOrEqual(viewport.height);
      const hitsBar = await bar.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!hit && element.contains(hit);
      });
      expect(hitsBar, `bar centre is clickable while its tooltip is open: ${label}`).toBe(true);
      await page.mouse.move(2, viewport.height - 2);
      await expect(tooltip).toBeHidden();
    }
  }
});

test("Run Phantom UI: download exports the selected trace as JSON", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const detailResponse = await fetch(`${runPhantom.url}/api/runs/${FIXTURE_PRIMARY_RUN_ID}/export`);
  expect(detailResponse.ok).toBe(true);
  const expectedTrace = await detailResponse.json();
  expect(expectedTrace.format).toBe("runphantom-trace/v1");

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const downloadButton = page.getByRole("button", { name: /^download$/i });
  await expect(downloadButton).toBeVisible({ timeout: 10_000 });

  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe(`trace-${FIXTURE_PRIMARY_RUN_ID}.json`);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(JSON.parse(readFileSync(downloadPath!, "utf8"))).toEqual(expectedTrace);
});

test("Run Phantom UI: saved conversation routes stay scoped to saved and live traces", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await saveRunPhantomRun(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);

  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}/convo`);
  await expect(page.getByRole("tab", { name: "Conversation" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("2 runs", { exact: true })).toBeVisible({ timeout: 10_000 });

  const openButtons = page.getByRole("button", { name: /^open →$/i });
  await expect(openButtons).toHaveCount(2);

  await openButtons.first().click();
  await expect(page).toHaveURL(new RegExp(`/saved/${FIXTURE_PRIMARY_RUN_ID}(?:[/?#]|$)`));

  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}/convo`);
  await expect(openButtons).toHaveCount(2);
  await openButtons.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${FIXTURE_SAVED_SIBLING_RUN_ID}(?:[/?#]|$)`));

  await saveRunPhantomRun(runPhantom.url, FIXTURE_SAVED_SIBLING_RUN_ID);
  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}/convo`);
  await expect(openButtons).toHaveCount(2);
  await openButtons.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/saved/${FIXTURE_SAVED_SIBLING_RUN_ID}(?:[/?#]|$)`));
});

test("Run Phantom UI: deleting a trace via the API removes only that sidebar row", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(runPhantom.url);
  const targetRow = page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`);
  await expect(targetRow).toBeVisible({ timeout: 10_000 });

  const deleteResponse = await fetch(`${runPhantom.url}/api/runs/${FIXTURE_PRIMARY_RUN_ID}`, {
    method: "DELETE",
  });
  expect(deleteResponse.ok, `DELETE /api/runs/${FIXTURE_PRIMARY_RUN_ID} -> ${deleteResponse.status}`).toBe(true);

  await expect(targetRow).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => page.locator("[data-run-id]").count(), { timeout: 5_000 }).toBe(2);
});

async function replayFinishedDemoReview(url: string): Promise<void> {
  const replay = await fetch(`${url}/api/demo-traces/replay`, { method: "POST" });
  expect(replay.ok).toBe(true);
  await expect.poll(async () => {
    const response = await fetch(`${url}/api/runs/detail/demo_review`);
    if (response.status === 404) return 0;
    expect(response.ok).toBe(true);
    const detail = await response.json() as { run: { finished?: number | null } };
    return detail.run.finished;
  }, { timeout: 20_000 }).toBe(1);
}

test("Run Phantom UI: the errors tooltip shows its last line whole and signals overflow", async ({ page, runPhantom }, testInfo) => {
  await replayFinishedDemoReview(runPhantom.url);

  // The error message was capped at 80px with overflow hidden, which cut
  // "2 passed, 1 failed." through the middle of its glyphs with no sign that
  // anything was missing.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${runPhantom.url}/runs/demo_review`);
  const trigger = page.getByLabel(/^1 run error\. Focus for details\.$/);
  await trigger.focus();
  const lastLine = page.getByText(/2 passed, 1 failed\./);
  await expect(lastLine).toBeVisible();
  const clipped = await lastLine.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()];
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    const problems: string[] = [];
    if (bottom > window.innerHeight) problems.push(`below viewport (${bottom} > ${window.innerHeight})`);
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowY === "visible") continue;
      const box = node.getBoundingClientRect();
      const clipBottom = box.top + node.clientTop + node.clientHeight;
      if (bottom > clipBottom + 0.5) problems.push(`clipped by ${node.className || node.tagName} (${bottom} > ${clipBottom})`);
    }
    return problems;
  });
  expect(clipped).toEqual([]);
  await expect(page.locator("[data-errors-overflow-hint]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("errors-tooltip-complete-message.png") });

  // When the viewport is too short for the whole list, the region must say so
  // and stay reachable from the keyboard without closing the tooltip.
  await page.setViewportSize({ width: 1280, height: 200 });
  await trigger.blur();
  await trigger.focus();
  const region = page.getByRole("region", { name: /error details/i });
  await expect(region).toBeVisible();
  expect(await region.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(page.locator("[data-errors-overflow-hint]")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("errors-tooltip-short-viewport-overflow.png") });
  await trigger.hover();
  await page.keyboard.press("Tab");
  await expect(region).toBeFocused();
  await page.mouse.move(1270, 190);
  await expect(region).toBeVisible();
  await expect(region).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator("[data-errors-overflow-hint]")).toHaveCount(0);
  await expect(lastLine).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(region).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Run Phantom UI: the span detail pane shows the whole span id", async ({ page, runPhantom }, testInfo) => {
  await replayFinishedDemoReview(runPhantom.url);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${runPhantom.url}/runs/demo_review/spans`);
  await page.locator('[data-span-row="demo_review_tool-1"]').click();
  // `span.id.slice(-12)` rendered "eview_tool-1", which reads as a mangled
  // word rather than an id.
  const idCell = page.getByText("span id", { exact: true }).locator("xpath=following-sibling::*[1]");
  await expect(idCell).toHaveText("demo_review_tool-1");
  await expect(idCell).toHaveRole("button");
  await expect(idCell).toHaveAccessibleName("Copy span id demo_review_tool-1");
  await expect(idCell).toHaveAttribute("title", "demo_review_tool-1");
  const overflow = await idCell.evaluate((element) => ({
    truncates: element.scrollWidth > element.clientWidth,
    textOverflow: getComputedStyle(element).textOverflow,
  }));
  expect(overflow.textOverflow).toBe("ellipsis");
  expect(overflow.truncates).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("span-detail-complete-identifier.png") });
});

test("Run Phantom UI: the header duration agrees with the span tree root", async ({ page, runPhantom }, testInfo) => {
  await replayFinishedDemoReview(runPhantom.url);

  // The header rounded the finished 6200ms run to whole seconds ("6s") while
  // the tree root read "6.2s" for the same trace.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${runPhantom.url}/runs/demo_review/spans`);
  const rootDuration = page.locator('[data-span-row="demo_review_root"] .font-mono').last();
  await expect(rootDuration).toHaveText("6.2s");
  const headerDuration = page.locator(".rp-meta-metrics").getByText("duration", { exact: true }).locator("xpath=following-sibling::span[1]");
  await expect(headerDuration).toHaveText("6.2s", { timeout: 10_000 });
  await page.screenshot({ path: testInfo.outputPath("settled-duration-matches-span-root.png") });
});

test("Run Phantom UI: run ids stay distinguishable in the sidebar and whole in the header", async ({ page, runPhantom }, testInfo) => {
  const replay = await fetch(`${runPhantom.url}/api/demo-traces/replay`, { method: "POST" });
  expect(replay.ok).toBe(true);

  // Every demo id starts "demo_", and a fixed five-character slice gave all
  // three rows the suffix "(demo_)" while the header read "demo_rev". The id
  // now lives on the meta line so the agent name keeps the title to itself.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${runPhantom.url}/runs/demo_review`);
  const expected: Record<string, { name: string; shortId: string }> = {
    demo_triage: { name: "triage_agent", shortId: "demo_t…" },
    demo_review: { name: "code_review_agent", shortId: "demo_rev…" },
    demo_research: { name: "research_agent", shortId: "demo_res…" },
  };
  const fitsItsBox = (element: HTMLElement) => element.scrollWidth <= element.clientWidth;
  for (const [runId, { name, shortId }] of Object.entries(expected)) {
    const row = page.locator(`[data-run-id="${runId}"]`);
    const nameText = row.locator("[data-run-name]");
    const shortIdText = row.locator("[data-run-short-id]");
    await expect.soft(nameText).toHaveText(name, { timeout: 20_000 });
    await expect.soft(shortIdText).toHaveText(shortId);
    await expect.soft(shortIdText).toHaveAttribute("title", runId);
    expect.soft(await nameText.evaluate(fitsItsBox), `${name} is shown whole at 1280px`).toBe(true);
    expect.soft(await shortIdText.evaluate(fitsItsBox), `${shortId} is shown whole at 1280px`).toBe(true);
    await expect.soft(row.getByRole("button")).toHaveAccessibleName(new RegExp(`^${name} Run \\w+ ${shortId} `));
  }

  const traceId = page.locator(".rp-meta-ids span[title='demo_review']");
  await expect(traceId).toHaveText("demo_review");
  const clipped = await traceId.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(clipped, "the full run id fits the header at 1280px").toBe(false);
  await page.screenshot({ path: testInfo.outputPath("distinct-run-identifiers-and-complete-header.png") });
});
