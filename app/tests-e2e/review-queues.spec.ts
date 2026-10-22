import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ReviewItem, ReviewQueue } from "../../src/review-queues/protocol";
const evidence = process.env.REVIEW_QUEUE_EVIDENCE_DIR ?? path.resolve("test-results/review-queues-component");
const externalProfile = process.env.REVIEW_QUEUE_CONNECTED !== undefined;
const connected = process.env.REVIEW_QUEUE_CONNECTED !== "0";
const fixturePath = connected ? "/review-queues" : "/tests-e2e/review-queue-component.html";
if (!externalProfile) {
  test.use({ baseURL: async ({ runPhantom }, use) => { await use(runPhantom.url); } });
  test.beforeEach(async ({ request }) => {
    for (const id of ["source-a", "source-b"]) {
      const imported = await request.post("/api/import-run", { data: {
        format: "runphantom-trace/v1",
        run: { id, name: id === "source-a" ? "Checkout response" : "Refund response", started_at: 1, last_updated_at: 2 },
        spans: [{ id: "response", run_id: id, name: "Agent response", span_type: "AGENT_ROOT", status: "OK",
          input_payload: `Input for ${id}`, output_payload: JSON.stringify(id === "source-a" ? { status: "paid", score: 3, ok: true } : { status: "refunded", score: 4, ok: false }),
          attributes: "{}", start_time_ms: 1, end_time_ms: 2, duration_ms: 1 }],
        liveEvents: [], annotations: [],
      } });
      expect(imported.status()).toBe(200);
      expect(await imported.json()).toMatchObject({ ok: true, runId: id, spansImported: 1 });
    }
    expect((await request.post("/api/evaluations/datasets", { data: { name: "Curated checkout examples" } })).status()).toBe(201);
  });
}
const navigation = (page: Page) => connected
  ? page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Evaluations", exact: true })
  : page.getByRole("link", { name: "Fixture evaluations navigation", exact: true });
async function delayAcknowledgment(page: Page, pattern: string) {
  await page.route(pattern, async route => {
    if (!connected) return route.continue({ headers: { ...route.request().headers(), "x-review-fixture-delay-ack": "1" } });
    const response = await route.fetch();
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.fulfill({ response });
  });
}

test("actual review component persists A/B drafts, immediately approves newest edit and promotes frozen typed output", async ({ page, request }) => {
  mkdirSync(evidence,{ recursive:true });
  const errors:string[]=[]; page.on("pageerror",error=>errors.push(error.message));
  await page.goto(fixturePath);
  if (connected) {
    await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Review queues", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "connected");
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return { faces: [...document.fonts].map(font => ({ family: font.family, status: font.status, weight: font.weight })), heading: getComputedStyle(document.querySelector("h1")!).fontFamily, resources: performance.getEntriesByType("resource").filter(entry => entry.name.includes("syne")) }; });
    writeFileSync(path.join(evidence, "font-proof.json"), JSON.stringify(fonts, null, 2));
    expect(fonts.heading).toContain("Syne");
    await expect.poll(() => page.evaluate(async () => { await document.fonts.ready; return { inter: [...document.fonts].some(font => font.family.replace(/["']/g, "") === "Inter Variable" && font.status === "loaded"), syne: [...document.fonts].some(font => font.family.replace(/["']/g, "") === "Syne" && font.status === "loaded") }; })).toEqual({ inter: true, syne: true });
  }
  await page.getByRole("textbox",{ name:"New queue name" }).fill("Checkout curation");
  await page.getByRole("button",{ name:"Create queue",exact:true }).click();
  const queues = await (await request.get("/api/review-queues")).json() as ReviewQueue[];
  const queue = queues.find(value=>value.name==="Checkout curation")!;
  await page.getByRole("combobox",{ name:"Source run",exact:true }).selectOption("source-a");
  await page.getByRole("button",{ name:"Add to queue",exact:true }).click();
  await expect(page.getByRole("region",{ name:"Frozen source",exact:true })).toContainText('"status":"paid"');
  const items = async()=> (await (await request.get(`/api/review-queues/${queue.id}/items`)).json()).items as Array<{ id:string;name:string;revision:number;state:string }>;
  const first = (await items())[0];
  await page.getByRole("combobox",{ name:"Source run",exact:true }).selectOption("source-b");
  await page.getByRole("button",{ name:"Add to queue",exact:true }).click();
  await expect.poll(async()=> (await items()).length).toBe(2);
  const second = (await items())[1];
  await page.getByRole("region",{ name:"Queue items",exact:true }).getByRole("button",{ name:/Checkout response/ }).click();
  await expect(page.getByRole("region",{ name:"Frozen source",exact:true })).toContainText("Input for source-a");
  await page.getByRole("textbox",{ name:/Expected response \(required\)/ }).fill("Expected A");
  await page.getByRole("region",{ name:"Queue items",exact:true }).getByRole("button",{ name:/Refund response/ }).click();
  await expect(page.getByRole("region",{ name:"Frozen source",exact:true })).toContainText("Input for source-b");
  await page.getByRole("textbox",{ name:/Expected response \(required\)/ }).fill("Expected B");
  const stored = async(id:string)=>(await (await request.get(`/api/review-queues/${queue.id}/window?centerId=${id}`)).json() as ReviewItem[]).find(row=>row.id===id)!;
  await expect.poll(async()=> (await stored(first.id)).draft.target.expectedOutput).toBe("Expected A");
  await expect.poll(async()=> (await stored(second.id)).draft.target.expectedOutput).toBe("Expected B");
  await page.getByRole("textbox",{ name:/Expected response \(required\)/ }).fill("Newest B before approval");
  await page.getByRole("button",{ name:"Approve local review",exact:true }).click();
  await expect.poll(async()=> (await stored(second.id)).state).toBe("approved");
  expect((await stored(second.id)).draft.target.expectedOutput).toBe("Newest B before approval");
  await page.getByRole("combobox",{ name:"Destination dataset",exact:true }).selectOption({ label:"Curated checkout examples · revision 1" });
  await page.getByRole("button",{ name:"Promote approved selection",exact:true }).click();
  await expect(page.getByRole("region",{ name:"Dataset promotion",exact:true })).toContainText("Saved revision 2");
  const revisions = await (await request.get("/api/evaluations/datasets")).json() as Array<{ id:string;latestVersion:number }>;
  const revision = await (await request.get(`/api/evaluations/datasets/${revisions[0].id}?version=2`)).json();
  expect(revision.cases).toHaveLength(1); expect(revision.cases[0].sourceOutput).toContain('"status":"refunded"'); expect(revision.cases[0].rules[0].value).toBe("Newest B before approval");
  expect((await stored(first.id)).state).toBe("draft"); expect((await stored(second.id)).state).toBe("promoted");
  await page.screenshot({ path:path.join(evidence,"review-desktop.png"),fullPage:true });
  if (connected) { await page.getByRole("heading", { name: "Review queues", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, "review-desktop-top.png"), fullPage: true }); }
  writeFileSync(path.join(evidence,"component-output.json"),JSON.stringify({ qualification:connected ? "actual source app and daemon" : "isolated component fixture with canonical migrations",queue,first:await stored(first.id),second:await stored(second.id),revision,errors },null,2));
  await page.setViewportSize({ width:390,height:844 }); await page.emulateMedia({ reducedMotion:"reduce" });
  await page.screenshot({ path:path.join(evidence,"review-mobile.png"),fullPage:true });
  if (connected) { await page.getByRole("heading", { name: "Review queues", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, "review-mobile-top.png"), fullPage: true }); }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true); expect(errors).toEqual([]);
  await request.put(`/api/evaluations/datasets/${revisions[0].id}`,{ data:{ expectedVersion:2,cases:[] } });
  await page.getByRole("link",{ name:"Open saved dataset revision",exact:true }).click();
  await expect(page.getByRole("combobox",{ name:"Dataset",exact:true })).toHaveValue(revisions[0].id);
  await expect(page.getByRole("combobox",{ name:"Revision",exact:true })).toHaveValue("2");
  await expect(page.getByRole("region",{ name:"Dataset cases",exact:true })).toContainText("Newest B before approval");
  await page.getByRole("combobox",{ name:"Revision",exact:true }).selectOption("3");
  await expect(page.getByRole("region",{ name:"Dataset cases",exact:true })).not.toContainText("Newest B before approval");
  await page.goBack(); await expect(page.getByRole("combobox",{ name:"Revision",exact:true })).toHaveValue("2");
  await page.reload(); await expect(page.getByRole("combobox",{ name:"Revision",exact:true })).toHaveValue("2");
  await expect(page.getByRole("region",{ name:"Dataset cases",exact:true })).toContainText("Newest B before approval");
});


test("existing Evaluations defaults retain first dataset and latest revision", async ({ page, request }) => {
  const made = await (await request.post("/api/evaluations/datasets",{ data:{ name:"Legacy selection dataset" } })).json();
  await request.put(`/api/evaluations/datasets/${made.datasetId}`,{ data:{ expectedVersion:1,cases:[] } });
  await page.goto("/evaluations");
  await expect(page.getByRole("combobox",{ name:"Dataset",exact:true })).toHaveValue(made.datasetId);
  await expect(page.getByRole("combobox",{ name:"Revision",exact:true })).toHaveValue("2");
});

test("explicit historical dataset link refuses first/latest fallback and invalid/deleted selections", async ({ page, request }) => {
  const datasets = await (await request.get("/api/evaluations/datasets")).json() as Array<{ id:string;name:string;latestVersion:number }>;
  const curated = datasets.find(value=>value.name==="Curated checkout examples")!;
  if (curated.latestVersion === 1) await request.put(`/api/evaluations/datasets/${curated.id}`,{ data:{ expectedVersion:1,cases:[] } });
  await request.post("/api/evaluations/datasets",{ data:{ name:"Selection decoy dataset" } });
  await page.goto(`/evaluations?datasetId=${curated.id}&version=1&runId=source-a`);
  await expect(page.getByRole("combobox",{ name:"Dataset",exact:true })).toHaveValue(curated.id);
  await expect(page.getByRole("combobox",{ name:"Revision",exact:true })).toHaveValue("1");
  for (const query of ["datasetId=missing&version=1","version=1",`datasetId=${curated.id}&datasetId=${curated.id}&version=1`,`datasetId=${curated.id}`,`datasetId=${curated.id}&version=0`,`datasetId=${curated.id}&version=1&version=2`,`datasetId=${curated.id}&version=9007199254740992`,`datasetId=${curated.id}&version=40`]) {
    await page.goto(`/evaluations?${query}`); await expect(page.getByRole("alert").first()).toContainText(/invalid|unavailable/i);
    await expect(page.getByRole("region",{ name:"Dataset cases",exact:true })).toHaveCount(0);
  }
  await request.delete(`/api/evaluations/datasets/${curated.id}`);
  await page.goto(`/evaluations?datasetId=${curated.id}&version=1`);
  await expect(page.getByRole("alert").first()).toContainText("unavailable");
  await expect(page.getByRole("region",{ name:"Dataset cases",exact:true })).toHaveCount(0);
});


test("typing shortcuts and SPA navigation retain in-flight drafts until acknowledgment", async ({ page, request }) => {
  const queue = await (await request.post("/api/review-queues",{ data:{ name:"Navigation retention" } })).json() as ReviewQueue;
  const item = await (await request.post(`/api/review-queues/${queue.id}/items`,{ data:{ runId:"source-a" } })).json() as ReviewItem;
  await page.goto(`${fixturePath}?queueId=${queue.id}&itemId=${item.id}`);
  const note = page.getByRole("textbox",{ name:/Review note/ });
  await expect(note).toBeVisible();
  await delayAcknowledgment(page, `**/api/review-queues/${queue.id}/items/${item.id}`);
  await note.fill("Retained while acknowledgment is delayed");
  await note.press("Control+Enter");
  const current = async()=>(await (await request.get(`/api/review-queues/${queue.id}/window?centerId=${item.id}`)).json() as ReviewItem[])[0];
  expect((await current()).state).toBe("draft");
  await expect.poll(async()=> (await current()).draft.note).toBe("Retained while acknowledgment is delayed");
  const nav = navigation(page); await nav.focus(); await nav.press("Enter");
  await expect(page.getByRole("dialog",{ name:"Retained drafts on this page",exact:true })).toBeVisible();
  await expect(page.getByRole("button",{ name:"Discard local drafts and leave",exact:true })).toBeDisabled();
  await page.getByRole("dialog").press("Control+Enter"); expect((await current()).state).toBe("draft");
  await page.getByRole("button",{ name:"Stay on this page",exact:true }).click(); await expect(note).toHaveValue("Retained while acknowledgment is delayed");
  await expect(page.getByRole("region",{ name:"Retained drafts",exact:true })).toHaveCount(0);
  await nav.focus(); await nav.press("Enter"); await expect(page.getByRole("heading",{ name:"Evaluations",exact:true })).toBeVisible();
});


test("structured number, boolean and choice targets persist as actual typed dataset expectations", async ({ page, request }) => {
  const schema = { fields:[
    { key:"score",label:"Score",type:"number",required:true,mapping:{ kind:"jsonPath",path:"score" } },
    { key:"ok",label:"Approved",type:"boolean",required:true,mapping:{ kind:"jsonPath",path:"ok" } },
    { key:"status",label:"Status",type:"enum",required:true,choices:["paid","refunded"],mapping:{ kind:"jsonPath",path:"status" } },
  ] };
  const queue = await (await request.post("/api/review-queues",{ data:{ name:"Typed targets",schema } })).json() as ReviewQueue;
  const item = await (await request.post(`/api/review-queues/${queue.id}/items`,{ data:{ runId:"source-a" } })).json() as ReviewItem;
  const dataset = await (await request.post("/api/evaluations/datasets",{ data:{ name:"Typed output examples" } })).json();
  await page.goto(`${fixturePath}?queueId=${queue.id}&itemId=${item.id}`);
  await page.getByRole("spinbutton",{ name:/Score \(required\)/ }).fill("3");
  await page.getByRole("combobox",{ name:/Approved \(required\)/ }).selectOption("true");
  await page.getByRole("combobox",{ name:/Status \(required\)/ }).selectOption("0");
  await page.getByRole("button",{ name:"Approve local review",exact:true }).click();
  await page.getByRole("combobox",{ name:"Destination dataset",exact:true }).selectOption(dataset.datasetId);
  await page.getByRole("button",{ name:"Promote approved selection",exact:true }).click();
  await expect(page.getByRole("region",{ name:"Dataset promotion",exact:true })).toContainText("Saved revision 2");
  const revision = await (await request.get(`/api/evaluations/datasets/${dataset.datasetId}?version=2`)).json();
  expect(revision.cases[0].rules).toEqual([{ kind:"jsonPath",path:"score",equals:3 },{ kind:"jsonPath",path:"ok",equals:true },{ kind:"jsonPath",path:"status",equals:"paid" }]);
  mkdirSync(evidence,{ recursive:true }); writeFileSync(path.join(evidence,"typed-target-output.json"),JSON.stringify({ qualification:connected ? "actual source app and daemon" : "unactivated native SQLite HTTP UI fixture",revision },null,2));
});

test("explicit approval and reapply keep source frames in the displayed window", async ({ page, request }) => {
  test.setTimeout(20000);
  const queue = await (await request.post("/api/review-queues",{ data:{ name:"Source window consistency" } })).json() as ReviewQueue;
  const first = await (await request.post(`/api/review-queues/${queue.id}/items`,{ data:{ runId:"source-a" } })).json() as ReviewItem;
  const second = await (await request.post(`/api/review-queues/${queue.id}/items`,{ data:{ runId:"source-b" } })).json() as ReviewItem;
  const current = async(id:string)=>(await (await request.get(`/api/review-queues/${queue.id}/window?centerId=${id}`)).json() as ReviewItem[]).find(row=>row.id===id)!;
  await page.goto(`${fixturePath}?queueId=${queue.id}&itemId=${first.id}`);
  const source = page.getByRole("region",{ name:"Frozen source",exact:true });
  const target = page.getByRole("textbox",{ name:/Expected output \(required\)/ });
  const items = page.getByRole("region",{ name:"Queue items",exact:true });
  const firstButton = items.getByRole("button",{ name:/Checkout response/ }), secondButton = items.getByRole("button",{ name:/Refund response/ });
  await target.fill("Retained first target");
  const otherWriter = await request.put(`/api/review-queues/${queue.id}/items/${first.id}`,{ data:{ expectedRevision:first.revision,mutationId:"window-lock-independent",draft:{ ...first.draft,target:{ expectedOutput:"Other writer" } } } });
  expect(otherWriter.status()).toBe(200);
  await expect(page.getByRole("button",{ name:"Reapply to latest revision",exact:true })).toBeVisible();
  await secondButton.click(); await expect(source).toContainText("Input for source-b");
  await delayAcknowledgment(page, `**/api/review-queues/${queue.id}/items/${first.id}`);
  await page.getByRole("button",{ name:"Reapply to latest revision",exact:true }).click();
  await expect.poll(async()=> (await current(first.id)).draft.target.expectedOutput).toBe("Retained first target");
  await expect(source).toContainText("Input for source-a"); await expect(target).toHaveValue("Retained first target");
  await expect(secondButton).toBeDisabled(); await expect(page.getByRole("combobox",{ name:"Review queue",exact:true })).toBeDisabled();
  await secondButton.click({ force:true }); await expect(source).toContainText("Input for source-a");
  await expect(secondButton).toBeEnabled(); await secondButton.click(); await expect(source).toContainText("Input for source-b");
  await delayAcknowledgment(page, "**/api/review-queues");
  await delayAcknowledgment(page, `**/api/review-queues/${queue.id}/items/${second.id}/*`);
  await target.fill("Newest second target"); await page.getByRole("button",{ name:"Approve local review",exact:true }).click();
  await expect.poll(async()=> (await current(second.id)).state).toBe("approved");
  await expect(firstButton).toBeDisabled(); await firstButton.click({ force:true }); await expect(source).toContainText("Input for source-b");
  await expect(page.getByRole("button",{ name:"Reopen review",exact:true })).toBeVisible(); await expect(firstButton).toBeDisabled();
  const nav = navigation(page); await nav.focus(); await nav.press("Enter");
  await expect(page.getByRole("dialog",{ name:"Retained drafts on this page",exact:true })).toBeVisible();
  await expect(page.getByRole("button",{ name:"Discard local drafts and leave",exact:true })).toBeDisabled();
  await page.getByRole("button",{ name:"Stay on this page",exact:true }).click(); await expect(source).toContainText("Input for source-b");
  await expect(firstButton).toBeEnabled();
  expect((await current(second.id)).draft.target.expectedOutput).toBe("Newest second target");
  await page.getByRole("button",{ name:"Reopen review",exact:true }).click();
  await expect.poll(async()=> (await current(second.id)).state).toBe("draft");
  await expect(firstButton).toBeDisabled(); await firstButton.click({ force:true }); await expect(source).toContainText("Input for source-b");
  await expect(firstButton).toBeEnabled(); await firstButton.click(); await expect(source).toContainText("Input for source-a");
  await page.getByRole("textbox",{ name:/Review note/ }).fill("Retained after source deletion");
  const latest = await current(first.id);
  expect((await request.put(`/api/review-queues/${queue.id}/items/${first.id}`,{ data:{ expectedRevision:latest.revision,mutationId:"window-lock-deletion",draft:{ ...latest.draft,note:"Other deletion writer" } } })).status()).toBe(200);
  await expect(page.getByRole("button",{ name:"Reapply to latest revision",exact:true })).toBeVisible();
  expect((await request.delete(`/api/review-queues/${queue.id}/items/${first.id}`,{ data:{ expectedRevision:(await current(first.id)).revision } })).status()).toBe(204);
  await page.getByRole("button",{ name:"Reapply to latest revision",exact:true }).click();
  await expect(page.getByRole("alert").first()).toContainText("not found");
  await expect(source).toHaveCount(0);
  await expect(page.getByRole("region",{ name:"Retained drafts",exact:true })).toContainText("Checkout response");
  const reopened = await current(second.id); await secondButton.click(); await expect(source).toContainText("Input for source-b");
  await page.getByRole("button",{ name:"Delete item",exact:true }).click(); await page.getByRole("button",{ name:"Confirm",exact:true }).click();
  await expect(source).toHaveCount(0); await expect(page.getByRole("dialog")).toHaveCount(0);
  const remaining = await (await request.get(`/api/review-queues/${queue.id}/items`)).json(); expect(remaining.items).toHaveLength(0);
  mkdirSync(evidence,{ recursive:true }); writeFileSync(path.join(evidence,"source-window-lifetime-output.json"),JSON.stringify({ qualification:connected ? "actual source app and daemon" : "unactivated native SQLite HTTP UI fixture",second:reopened,deletedItem:first.id,retainedDeletionRefused:true,confirmedItemDeletion:true,remainingItems:remaining.items.length },null,2));
});
