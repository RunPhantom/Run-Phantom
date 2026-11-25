import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const failedRunId = "waterfall-failed-run";
const cleanRunId = "waterfall-clean-run";

function trace(runId: string, failing: boolean) {
  const at = 1_795_000_000_000;
  const span = (id: string, fields: Record<string, unknown>) => ({
    run_id: runId, id: `${runId}-${id}`, status: "OK", input_payload: null, output_payload: null, ...fields,
    parent_span_id: typeof fields.parent_span_id === "string" ? `${runId}-${fields.parent_span_id}` : null,
  });
  return {
    run: { id: runId, name: "code_review_agent", event_name: "code_review_agent", started_at: at, last_updated_at: at + 3000 },
    spans: [
      span("root", { name: "code_review_agent", span_type: "AGENT_ROOT", status: failing ? "ERROR" : "OK", start_time_ms: at, end_time_ms: at + 3000, duration_ms: 3000,
        output_payload: failing ? "Exit code 1" : "Review complete" }),
      span("plan", { parent_span_id: "root", name: "Plan review", span_type: "LLM_GENERATION", start_time_ms: at + 100, end_time_ms: at + 1300, duration_ms: 1200,
        model: "claude-haiku-4-5-20251001", provider: "anthropic", input_tokens: 2000, output_tokens: 200,
        input_payload: "Review PR #842", output_payload: "## Plan\n\n- run the tests\n- read **session.ts**" }),
      span("tests", { parent_span_id: "root", name: "run_tests", span_type: "TOOL_CALL", status: failing ? "ERROR" : "OK", start_time_ms: at + 1400, end_time_ms: at + 2120, duration_ms: 720,
        input_payload: "{\"path\":\"auth/\"}", output_payload: failing ? "{\"message\":\"Exit code 1. 2 tests failed\"}" : "{\"passed\":12}" }),
      span("bun", { parent_span_id: "tests", name: "bun test auth/", span_type: "TOOL_CALL", status: failing ? "ERROR" : "OK", start_time_ms: at + 1410, end_time_ms: at + 2090, duration_ms: 680,
        input_payload: "bun test auth/", output_payload: failing ? "Exit code 1\nexpected 401, got 200" : "12 pass" }),
      span("summary", { parent_span_id: "root", name: "Summarise", span_type: "LLM_GENERATION", start_time_ms: at + 2200, end_time_ms: at + 2900, duration_ms: 700,
        model: "claude-haiku-4-5-20251001", provider: "anthropic", input_tokens: 900, output_tokens: 120,
        input_payload: "Summarise the failures", output_payload: "Two blockers in auth middleware." }),
    ],
    liveEvents: [],
  };
}

async function seed(request: APIRequestContext, url: string) {
  for (const [runId, failing] of [[failedRunId, true], [cleanRunId, false]] as const) {
    const response = await request.post(`${url}/api/import-run`, { data: trace(runId, failing) });
    expect(response.ok(), await response.text()).toBe(true);
  }
}

const row = (page: Page, runId: string, id: string) => page.locator(`[data-span-row="${runId}-${id}"]`);

test("waterfall: nested steps share one time axis, kinds filter, and the header names the failure", async ({ page, request, runPhantom }) => {
  await seed(request, runPhantom.url);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${failedRunId}/spans`);

  await expect(page.locator("[data-run-failure]")).toHaveText("Failed at step 3 of 4 — bun test auth/ (680ms): Exit code 1");
  await expect(page.locator("[data-span-row]")).toHaveCount(5);

  const nameLeft = async (id: string) => (await row(page, failedRunId, id).getByText(id === "bun" ? "bun test auth/" : id === "tests" ? "run_tests" : "code_review_agent", { exact: true }).boundingBox())!.x;
  expect(await nameLeft("tests")).toBeGreaterThan(await nameLeft("root"));
  expect(await nameLeft("bun")).toBeGreaterThan(await nameLeft("tests"));

  const barLeft = async (id: string) => (await row(page, failedRunId, id).locator("[data-trace-track] > span").boundingBox())!.x;
  expect(await barLeft("plan")).toBeLessThan(await barLeft("tests"));
  expect(await barLeft("tests")).toBeLessThan(await barLeft("summary"));
  await expect(row(page, failedRunId, "plan").locator("[data-span-duration]")).toHaveText("1.2s");
  await expect(row(page, failedRunId, "tests")).toHaveAttribute("data-span-status", "error");
  await expect(page.locator("[data-trace-errors]")).toHaveText("3 failed steps");

  await row(page, failedRunId, "tests").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, failedRunId, "tests")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, failedRunId, "bun")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(row(page, failedRunId, "bun")).toBeVisible();

  const tools = page.getByRole("group", { name: "Show step kinds" }).getByRole("button", { name: /^Tools/ });
  await tools.click();
  await expect(tools).toHaveAttribute("aria-pressed", "false");
  await expect(row(page, failedRunId, "tests")).toHaveCount(0);
  await expect(row(page, failedRunId, "root")).toBeVisible();
  await expect(row(page, failedRunId, "plan")).toBeVisible();
  await tools.click();

  await page.locator("[data-run-failure]").click();
  await expect(page).toHaveURL(new RegExp(`/runs/${failedRunId}/span/${failedRunId}-bun$`));

  await page.goto(`${runPhantom.url}/runs/${cleanRunId}/spans`);
  await expect(page.locator("[data-span-row]")).toHaveCount(5);
  const header = await page.locator("[data-run-header]").evaluate(element => element.parentElement!.parentElement!.getBoundingClientRect().top);
  const tabsBottom = await page.getByRole("tablist", { name: "Run views" }).evaluate(element => element.getBoundingClientRect().bottom);
  expect(tabsBottom - header, "run header with its tabs").toBeLessThanOrEqual(124);
});

test("span drawer: the error comes first, payloads toggle, and the docked width persists", async ({ page, request, runPhantom }) => {
  await seed(request, runPhantom.url);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${failedRunId}/spans`);
  await row(page, failedRunId, "tests").click();
  await expect(page).toHaveURL(new RegExp(`/span/${failedRunId}-tests$`));

  const drawer = page.getByRole("region", { name: "Span details", exact: true });
  await expect(drawer).toBeVisible();
  const error = drawer.getByText("Exit code 1. 2 tests failed", { exact: true });
  await expect(error).toBeVisible();
  const input = drawer.getByText("Input", { exact: true });
  expect((await error.boundingBox())!.y).toBeLessThan((await input.boundingBox())!.y);
  await expect(drawer.getByRole("button", { name: "Copy step as JSON" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: `Copy span id ${failedRunId}-tests` })).toBeVisible();

  await row(page, failedRunId, "plan").click();
  await expect(drawer.getByRole("heading", { name: "Plan review" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Plan", level: 2 })).toBeVisible();
  await drawer.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(drawer.getByText("## Plan", { exact: false })).toBeVisible();
  await drawer.getByRole("button", { name: "Formatted", exact: true }).click();

  const handle = page.getByRole("separator", { name: "Resize step details" });
  const before = Number(await handle.getAttribute("aria-valuenow"));
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  const widened = Number(await handle.getAttribute("aria-valuenow"));
  expect(widened).toBeGreaterThan(before + 80);
  await page.reload();
  await expect(page.getByRole("separator", { name: "Resize step details" })).toHaveAttribute("aria-valuenow", String(widened));

  await row(page, failedRunId, "plan").focus();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/runs/${failedRunId}/spans$`));
});

test("in-trace search: the find shortcut filters to matches with their parents and Escape clears it", async ({ page, request, runPhantom }) => {
  await seed(request, runPhantom.url);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${failedRunId}/spans`);
  await expect(page.locator("[data-span-row]")).toHaveCount(5);

  const find = page.getByRole("searchbox", { name: "Find step" });
  // The app advertises the chord it listens for (Meta on macOS, Control elsewhere).
  const chord = (await find.getAttribute("aria-keyshortcuts"))!;
  await row(page, failedRunId, "plan").focus();
  await page.keyboard.press(chord);
  await expect(find).toBeFocused();
  await find.fill("bun test");
  await expect(page.locator("[data-span-row]")).toHaveCount(3);
  await expect(row(page, failedRunId, "bun")).toHaveAttribute("data-search-match", "active");
  await expect(row(page, failedRunId, "bun").locator("mark")).toHaveText("bun test");
  await expect(page.getByRole("status").filter({ hasText: "1 of 1" })).toBeVisible();

  await find.fill("expected 401");
  await expect(row(page, failedRunId, "bun")).toBeVisible();
  await expect(row(page, failedRunId, "bun").getByRole("img", { name: "Match inside the step's input or output" })).toBeVisible();

  await find.press("Escape");
  await expect(find).toHaveValue("");
  await expect(page.locator("[data-span-row]")).toHaveCount(5);
});

test("keyboard: j and k move between steps, Enter opens the step, e jumps to failures", async ({ page, request, runPhantom }) => {
  await seed(request, runPhantom.url);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${failedRunId}/spans`);
  await row(page, failedRunId, "root").focus();
  await page.keyboard.press("j");
  await expect(row(page, failedRunId, "plan")).toBeFocused();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(row(page, failedRunId, "bun")).toBeFocused();
  await page.keyboard.press("k");
  await expect(row(page, failedRunId, "tests")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/span/${failedRunId}-tests$`));
  await expect(page.getByRole("region", { name: "Span details" }).getByRole("heading", { name: "run_tests" })).toBeVisible();

  await row(page, failedRunId, "summary").focus();
  await page.keyboard.press("e");
  await expect(page).toHaveURL(new RegExp(`/span/${failedRunId}-root$`));
});

test("run header: secondary actions live in one overflow menu", async ({ page, request, runPhantom }) => {
  await seed(request, runPhantom.url);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${cleanRunId}`);
  const actions = page.locator("[data-run-actions]");
  for (const name of ["Save", "Debug", "Replay", "More actions"]) await expect(actions.getByRole("button", { name, exact: true })).toBeVisible();
  for (const name of ["Annotate", "Download"]) await expect(actions.getByRole("button", { name, exact: true })).toHaveCount(0);

  const more = page.getByRole("button", { name: "More actions", exact: true });
  await more.click();
  const menu = page.getByRole("menu", { name: "Run actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Annotate", "Download", "Verify app", "Evaluate run", "Attach test report", "Delete run"]);
  await expect(menu.getByRole("menuitem", { name: "Annotate" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Download" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Delete run" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  await more.click();
  const download = page.waitForEvent("download");
  await menu.getByRole("menuitem", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe(`trace-${cleanRunId}.json`);
});

test("mobile: the trace fills the screen and a step opens as a full-screen sheet", async ({ page, request, runPhantom }) => {
  await seed(request, runPhantom.url);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runPhantom.url}/runs/${failedRunId}/spans`);
  const panel = page.getByRole("tabpanel", { name: "Span Tree" });
  await expect(row(page, failedRunId, "root")).toBeVisible();
  // The run header used to leave the trace an 84px window at this size.
  expect((await panel.boundingBox())!.height).toBeGreaterThan(844 * 0.55);

  await row(page, failedRunId, "plan").click();
  const sheet = page.getByRole("dialog", { name: "Step details" });
  await expect(sheet).toBeVisible();
  // The sheet rises 12px as it enters, so measure once it has settled.
  await expect.poll(async () => (await sheet.boundingBox())!.y).toBeCloseTo(0, 0);
  const box = (await sheet.boundingBox())!;
  expect(box.width).toBeCloseTo(390, 0);
  expect(box.height).toBeCloseTo(844, 0);
  await expect(sheet.getByRole("button", { name: "Back to span list" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(row(page, failedRunId, "plan")).toBeVisible();
});
