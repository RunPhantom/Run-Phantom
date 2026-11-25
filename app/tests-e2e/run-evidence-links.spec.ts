import { expect, test } from "./fixtures";
import { EVALUATION_RUNS, seedEvaluationRuns } from "./evaluation-fixture";

test("Evaluate run opens Evaluations with that run preselected as the source of a new case", async ({ page, request, runPhantom }) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${runPhantom.url}/runs/${EVALUATION_RUNS.baseline}`);
  // No report is attached yet, so the run offers to attach one instead of linking to an empty page.
  await expect(page.getByRole("link", { name: /Attached test reports/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Reported completion evidence" })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Attach test report", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Evaluate run", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Evaluate run", exact: true }).click();
  const linked = page.getByRole("region", { name: "Run to evaluate", exact: true });
  await expect(linked).toContainText("as a regression case");
  await expect(linked).toContainText("Create a dataset first");
  const name = page.getByRole("textbox", { name: "Dataset name", exact: true });
  await expect(name).toHaveValue(/ regression cases$/);
  const defaultName = await name.inputValue();
  await page.getByRole("button", { name: "Create dataset", exact: true }).click();
  await expect(linked).toContainText("preselected as the source run");
  await expect(page.getByRole("combobox", { name: "Dataset", exact: true }).locator("option", { hasText: defaultName })).toHaveCount(1);
  await expect(name).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Source run", exact: true })).toHaveValue(EVALUATION_RUNS.baseline);
  await expect(page.getByRole("region", { name: "Source snapshot", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Case name", exact: true }).fill("Linked run case");
  await page.getByRole("group", { name: "Rule 1", exact: true }).getByRole("textbox", { name: /^Expected text/ }).fill("paid");
  await expect(page.getByRole("button", { name: "Add case", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Add case", exact: true }).click();
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Revision", exact: true })).toHaveValue("2");

  await page.goto(`${runPhantom.url}/evaluations?view=evidence&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  await expect(page.getByLabel("Report files", { exact: true })).toBeVisible();
  expect(errors.filter(text => /404|Inventory revision not found/.test(text))).toEqual([]);
});

test("Evaluate run names the dataset after a run that is not in the loaded run list", async ({ page, request, runPhantom }) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const listed = await (await request.get(`${runPhantom.url}/api/runs`)).json() as { id: string; display_name?: string | null; event_name?: string | null; name?: string | null }[];
  const run = listed.find(item => item.id === EVALUATION_RUNS.baseline)!;
  await page.route(url => url.pathname === "/api/runs", route => route.fulfill({ json: [] }));
  await page.goto(`${runPhantom.url}/evaluations?runId=${EVALUATION_RUNS.baseline}`);
  const name = page.getByRole("textbox", { name: "Dataset name", exact: true });
  await expect(name).toHaveValue(/ regression cases$/);
  expect(await name.inputValue()).not.toContain(EVALUATION_RUNS.baseline.slice(0, 12));
  await expect(page.getByRole("region", { name: "Run to evaluate", exact: true })).toContainText(run.display_name || run.event_name || run.name || "");
});

test("attaching a test report to a run links it from the run with the current count", async ({ page, request, runPhantom }) => {
  await seedEvaluationRuns(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${EVALUATION_RUNS.baseline}`);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Attached test reports/ })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Attach test report", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`));
  const workspace = page.getByTestId("evidence-workspace");
  await workspace.getByLabel("Report files", { exact: true }).setInputFiles({ name: "unit.xml", mimeType: "application/xml", buffer: Buffer.from('<testsuite tests="1"><testcase name="checkout total"/></testsuite>') });
  await workspace.getByRole("button", { name: "Import reports", exact: true }).click();
  await expect(workspace.getByRole("region", { name: "Persisted evidence report", exact: true })).toBeVisible();

  // Back in the same page session, so a cached empty lookup would hide the link.
  await page.goBack();
  const link = page.getByRole("link", { name: "Attached test reports (1)", exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/evaluations\\?view=evidence&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}$`));
  await expect(page.getByTestId("evidence-workspace").getByRole("combobox", { name: "Evidence attachment", exact: true })).toHaveValue(EVALUATION_RUNS.baseline);
});

test("agent markdown keeps glyph bullets as a list and ordered markers beside their text", async ({ page, request, runPhantom }) => {
  const traceId = "ab".repeat(16), start = Date.now() - 10_000;
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const text = "Sources:\n\n• **Bloomberg:** first item.\n• **MacRumors:** second item.\n• **DigiTimes:** third item.\n\nBlockers:\n\n1. **Session expiry** is not reset.\n\n2. **CSRF** check is missing.";
  const span = { traceId, spanId: "cd".repeat(8), name: "ai.generateText", startTimeUnixNano: String(BigInt(start) * 1_000_000n), endTimeUnixNano: String(BigInt(start + 900) * 1_000_000n), status: { code: 1 },
    attributes: [attribute("ai.operationId", "ai.generateText"), attribute("ai.telemetry.metadata.runphantom.eventName", "markdown_agent"),
      attribute("ai.prompt", JSON.stringify({ messages: [{ role: "user", content: "List the sources and blockers." }] })), attribute("ai.response.text", text), attribute("ai.model.id", "gpt-5-nano")] };
  expect((await request.post(`${runPhantom.url}/v1/traces`, { data: { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] } })).ok()).toBe(true);
  await page.goto(`${runPhantom.url}/runs/${traceId}`);
  const markdown = page.locator(".streamdown").filter({ hasText: "Bloomberg:" }).first();
  await expect(markdown.locator("ul > li")).toHaveCount(3);
  await expect(markdown.locator("ul > li").nth(1)).toContainText("MacRumors: second item.");
  await expect(markdown).not.toContainText("•");
  const items = markdown.locator("ol > li");
  await expect(items).toHaveCount(2);
  expect(await markdown.locator("ol").evaluate(element => getComputedStyle(element).listStylePosition)).toBe("outside");
  const [itemBox, textBox] = [await items.first().boundingBox(), await items.first().getByText("Session expiry").boundingBox()];
  expect(Math.abs(itemBox!.y - textBox!.y)).toBeLessThan(8);
});
