import { test, expect, connectTarget, observe, act } from "./verification-fixture";
import type { PortableSnapshots, SavedSemanticSnapshot, SemanticTreeResult } from "../../src/verification/snapshot-contract";
import { readFileSync } from "node:fs";

test("semantic tree uses actual SDK parentage, boundaries and privacy without creating live handles", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => {
    document.body.innerHTML = `<main aria-label="Workspace"><div><section aria-label="Cart"><div><button>A</button><button>A</button></div></section></div><div id="shadow" style="min-height:30px"></div><iframe id="frame" srcdoc='<button>Frame Ω</button>'></iframe><div hidden><button>Hidden sentinel</button></div><div data-runphantom-private><button>Private sentinel</button></div><input id="fill" aria-label="Private entry" value="Private form value"><div id="closed" style="min-height:30px"></div></main>`;
    document.querySelector("#shadow")!.attachShadow({ mode: "open" }).innerHTML = '<div><button>Shadow λ</button></div>';
    document.querySelector("#closed")!.attachShadow({ mode: "closed" }).innerHTML = '<button>Closed sentinel</button>';
  });
  await expect(page.frameLocator("#frame").getByRole("button", { name: "Frame Ω" })).toBeVisible();
  const response = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/snapshots`, { data: { name: "Projected tree" } });
  expect(response.status()).toBe(201); const saved = await response.json() as SavedSemanticSnapshot;
  const nodes = saved.tree.nodes; expect(saved.tree.availability).toBe("complete");
  const cart = nodes.findIndex(node => node.name === "Cart"); const a = nodes.map((node, index) => ({ node, index })).filter(item => item.node.name === "A"); expect(a).toHaveLength(2);
  for (const { node } of a) expect(node.parent).toEqual({ kind: "node", index: cart });
  for (const [name, kind] of [["Shadow λ", "open-shadow"], ["Frame Ω", "same-origin-frame"]]) {
    const child = nodes.find(node => node.name === name)!; const region = saved.tree.regions[child.region]; expect(region.kind).toBe(kind);
    if (region.kind === "document") throw new Error("Expected an observed boundary");
    expect(region.parentage).toBe("known"); expect(nodes[region.hostIndex!].kind).toBe("boundary-host"); expect(child.parent).toEqual({ kind: "root" });
  }
  // Native head elements in both documents plus the explicit hidden fixture subtree.
  expect(saved.tree.coverage).toMatchObject({ privateSubtrees: 1, hiddenSubtrees: 3, closedShadowRoots: "unobservable", openShadowRoots: 1, sameOriginFrames: 1 });
  const wire = JSON.stringify(saved); for (const sentinel of ["Hidden sentinel", "Private sentinel", "Closed sentinel", "Private form value", "rpref_"]) expect(wire).not.toContain(sentinel);
  expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(0);
  await act(request, runPhantom, session.id, { type: "fill", selector: "#fill", value: "node" });
  await page.evaluate(() => { const button = document.createElement("button"); button.textContent = "node"; document.body.append(button); });
  const privateCapture = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/snapshots`, { data: { name: "Privacy observation" } }); expect(privateCapture.status()).toBe(201);
  const redacted = await privateCapture.json() as SavedSemanticSnapshot; expect(redacted.tree.source).toBe("sdk-reported"); expect(redacted.tree.nodes.some(node => node.name === "[REDACTED]" && node.partial)).toBe(true); expect(redacted.tree.nodes.every(node => node.parent.kind === "root" || node.parent.kind === "node")).toBe(true);
});

test("actual SDK tree caps retain typed partial metadata and disabled instrumentation does not traverse", async ({ page, request, runPhantom, targetApp }) => {
  const createdResponse = await request.post(`${runPhantom.url}/api/verification/sessions`, { data: { origin: targetApp.origin } }); const created = await createdResponse.json() as { id: string; token: string; sdkUrl: string };
  await page.goto(targetApp.origin);
  await page.evaluate(async ({ url, id, token, sdkUrl }) => { const sdk = await import(sdkUrl); window.runtime = sdk.connect({ url, sessionId: id, token, semanticSnapshots: false }); }, { url: runPhantom.url, ...created, sdkUrl: new URL(created.sdkUrl, runPhantom.url).href });
  await expect.poll(async () => (await observe(request, runPhantom, created.id)).session.connected).toBe(true);
  expect((await observe(request, runPhantom, created.id)).session.capabilities).not.toContain("semantic-tree");
  const denied = await request.post(`${runPhantom.url}/api/verification/sessions/${created.id}/snapshots`, { data: { name: "Disabled" } }); expect(denied.status()).toBe(409);
  expect(await (await request.get(`${runPhantom.url}/api/verification/snapshots`)).json()).toEqual([]);
  await page.evaluate(() => window.runtime.disconnect());
  const current = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => { document.body.innerHTML = Array.from({ length: 130 }, (_, index) => `<button>${index} ${"汉".repeat(230)}</button>`).join(""); });
  const captured = await request.post(`${runPhantom.url}/api/verification/sessions/${current.id}/snapshots`, { data: { name: "Bounded capture" } }); expect(captured.status()).toBe(201);
  const output = await captured.json() as SavedSemanticSnapshot;
  expect(output.tree.nodes.length).toBeGreaterThan(0); expect(output.tree.nodes.length).toBeLessThan(130); expect(output.tree.availability).toBe("partial"); expect(output.tree.coverage.reasons).toContain("transport-budget-limit"); expect(new TextEncoder().encode(JSON.stringify(output.tree)).length).toBeLessThanOrEqual(16 * 1024);
  expect(output.tree.nodes.every(node => typeof node.disabled === "boolean" && typeof node.readonly === "boolean" && node.name.length <= 240)).toBe(true);
  const command = await request.post(`${runPhantom.url}/api/verification/sessions/${current.id}/command`, { data: { type: "semantic-tree" } }); expect((await command.json() as { ok: boolean; result: SemanticTreeResult }).ok).toBe(true);
});

test("saved snapshots compare duplicate counts and portable UI transfer after disconnect and reload", async ({ page, context, request, runPhantom, targetApp }, testInfo) => {
  await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => { document.body.innerHTML = '<button>A</button><button>A</button><button>B</button>'; });
  const ui = await context.newPage();
  try {
    await ui.setViewportSize({ width: 1440, height: 1000 }); await ui.goto(`${runPhantom.url}/verification`);
    const panel = ui.getByRole("region", { name: "Semantic snapshots", exact: true });
    await panel.getByLabel("Snapshot name", { exact: true }).fill("Before duplicate change"); await panel.getByRole("button", { name: "Capture snapshot", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("Observation saved");
    await page.evaluate(() => { document.body.innerHTML = '<button>A</button><button>B</button><button>B</button>'; });
    await panel.getByLabel("Snapshot name", { exact: true }).fill("After duplicate change"); await panel.getByRole("button", { name: "Capture snapshot", exact: true }).click();
    await expect(panel.getByLabel("After snapshot", { exact: true }).locator("option")).toHaveCount(3);
    await panel.getByRole("button", { name: "Compare snapshots", exact: true }).click();
    const comparison = panel.getByRole("article", { name: "Semantic snapshot comparison" }); await expect(comparison).toContainText("1 additions · 1 removals · 2 matched");
    await expect(comparison.getByRole("heading")).toHaveText("Observed semantic changes"); await expect(comparison).toContainText("Duplicates are counted separately"); await expect(comparison.getByRole("region", { name: "Snapshot diff rows" })).toContainText("+ Insert button: B");
    const list = await (await request.get(`${runPhantom.url}/api/verification/snapshots`)).json() as SavedSemanticSnapshot[]; expect(list).toHaveLength(2);
    const before = list.find(item => item.name === "Before duplicate change")!; const after = list.find(item => item.name === "After duplicate change")!;
    const downloadReady = ui.waitForEvent("download"); await panel.getByRole("button", { name: "Export selected snapshots" }).click(); const download = await downloadReady;
    const transferPath = testInfo.outputPath("runphantom-semantic-snapshots.json"); await download.saveAs(transferPath); const artifact = JSON.parse(readFileSync(transferPath, "utf8")) as PortableSnapshots;
    expect(artifact.entries.map(entry => entry.contentDigest)).toEqual([before.contentDigest, after.contentDigest]); expect(JSON.stringify(artifact)).not.toMatch(/sessionId|connectionGeneration|runId|token|rpref_/);
    await page.evaluate(() => window.runtime.disconnect()); await expect(panel.getByRole("button", { name: "Capture snapshot", exact: true })).toBeDisabled(); await expect(panel.getByRole("button", { name: "Compare snapshots", exact: true })).toBeEnabled();
    await ui.reload(); await panel.getByLabel("Before snapshot", { exact: true }).selectOption(before.id); await panel.getByLabel("After snapshot", { exact: true }).selectOption(after.id); await panel.getByRole("button", { name: "Compare snapshots", exact: true }).click(); await expect(comparison).toContainText("1 additions · 1 removals · 2 matched");
    await panel.getByLabel("Snapshot transfer file", { exact: true }).setInputFiles(transferPath); await expect(panel.getByRole("status")).toContainText("Evidence imported with new local IDs");
    await panel.getByRole("button", { name: "Compare snapshots", exact: true }).click(); await expect(comparison).toContainText("1 additions · 1 removals · 2 matched");
    const imported = (await (await request.get(`${runPhantom.url}/api/verification/snapshots`)).json() as SavedSemanticSnapshot[]).filter(item => item.source === "imported-evidence"); expect(imported).toHaveLength(2); expect(imported.every(item => item.sessionId === null && item.connectionGeneration === null)).toBe(true);
    await comparison.scrollIntoViewIfNeeded(); await expect(comparison.getByRole("region", { name: "Snapshot diff rows" })).toBeVisible(); await ui.screenshot({ path: testInfo.outputPath("f25-diff-desktop.png") });
    await ui.setViewportSize({ width: 390, height: 844 }); await comparison.scrollIntoViewIfNeeded(); await ui.mouse.wheel(0, 120); await expect(comparison.getByRole("heading")).toBeVisible(); await ui.screenshot({ path: testInfo.outputPath("f25-diff-mobile.png") });
    expect(await ui.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await ui.setViewportSize({ width: 320, height: 740 }); await panel.getByLabel("Before snapshot", { exact: true }).scrollIntoViewIfNeeded(); expect(await ui.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await expect(panel.getByLabel("Before snapshot", { exact: true })).toBeVisible();
  } finally {
    if (testInfo.status !== testInfo.expectedStatus) await ui.screenshot({ path: testInfo.outputPath("f25-ui-failure.png") });
    await ui.close();
  }
});

test("UI invalid transfer retains draft and both selections while refusing every entry", async ({ page, context, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => { document.body.innerHTML = '<button>Original</button>'; });
  const beforeResponse = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/snapshots`, { data: { name: "Original evidence" } }); const before = await beforeResponse.json() as SavedSemanticSnapshot;
  const ui = await context.newPage();
  try {
    await ui.goto(`${runPhantom.url}/verification`); const panel = ui.getByRole("region", { name: "Semantic snapshots", exact: true });
    await panel.getByLabel("Before snapshot", { exact: true }).selectOption(before.id); await panel.getByLabel("After snapshot", { exact: true }).selectOption(before.id); await panel.getByLabel("Snapshot name", { exact: true }).fill("Keep this draft");
    const exportedResponse = await request.post(`${runPhantom.url}/api/verification/snapshots/export`, { data: { ids: [before.id] } }); const exported = await exportedResponse.json() as PortableSnapshots;
    const bad = { ...exported, entries: [exported.entries[0], { ...exported.entries[0], contentDigest: "f".repeat(64) }] };
    await panel.getByLabel("Snapshot transfer file", { exact: true }).setInputFiles({ name: "invalid-semantic-snapshots.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bad)) });
    await expect(panel.getByRole("alert")).toContainText("digest mismatch"); await expect(panel.getByLabel("Snapshot name", { exact: true })).toHaveValue("Keep this draft"); await expect(panel.getByLabel("Before snapshot", { exact: true })).toHaveValue(before.id); await expect(panel.getByLabel("After snapshot", { exact: true })).toHaveValue(before.id);
    expect((await (await request.get(`${runPhantom.url}/api/verification/snapshots`)).json() as SavedSemanticSnapshot[]).map(item => item.id)).toEqual([before.id]);
    await panel.getByRole("button", { name: "Compare snapshots", exact: true }).click(); await expect(panel.getByRole("heading", { name: "No observed semantic changes in the captured scope", exact: true })).toBeVisible();
  } finally { await ui.close(); }
});

test("empty observed boundaries and inaccessible frames retain explicit graph coverage", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(async inaccessibleUrl => {
    document.body.innerHTML = '<div id="empty-root" style="min-height:30px"></div><iframe id="empty-frame" srcdoc="<!doctype html><body></body>"></iframe>';
    document.querySelector("#empty-root")!.attachShadow({ mode: "open" });
    const frame = document.createElement("iframe"); frame.id = "inaccessible"; frame.src = inaccessibleUrl;
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve(); }); document.body.append(frame); await loaded;
  }, `${runPhantom.url}/health`);
  const response = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/snapshots`, { data: { name: "Boundary coverage" } }); expect(response.status()).toBe(201);
  const output = await response.json() as SavedSemanticSnapshot;
  expect(output.tree.regions.map(region => region.kind)).toEqual(["document", "open-shadow", "same-origin-frame"]);
  expect(output.tree.nodes.every(node => node.kind === "boundary-host")).toBe(true); expect(output.tree.coverage).toMatchObject({ openShadowRoots: 1, sameOriginFrames: 1, inaccessibleFrames: 1, complete: false }); expect(output.tree.availability).toBe("partial");
  expect(output.tree.coverage.reasons).toContain("inaccessible-frame"); expect(output.tree.coverage.unread).toContainEqual({ tag: "iframe", reason: "inaccessible-frame" });
});

test("tree observations do not consume live-reference allowance over more than 1000 replaced controls", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  for (let turn = 0; turn < 50; turn++) {
    await page.evaluate(turn => { document.body.innerHTML = Array.from({ length: 21 }, (_, index) => `<button>Control ${turn}-${index}</button>`).join(""); }, turn);
    const observed = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/command`, { data: { type: "semantic-tree" } });
    const output = await observed.json() as { ok: boolean; result: SemanticTreeResult }; expect(output.ok).toBe(true); expect(output.result.nodes).toHaveLength(21); expect(output.result.availability).toBe("complete"); expect(JSON.stringify(output.result)).not.toContain("rpref_");
  }
  await page.evaluate(() => { document.body.innerHTML = '<button>Fresh live target</button><output>0</output>'; document.querySelector("button")!.onclick = () => { document.querySelector("output")!.textContent = "1"; }; });
  const found = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/command`, { data: { type: "find", query: { kind: "name", name: "Fresh live target" } } });
  const result = await found.json() as { ok: boolean; result: { status: string; ref: string } }; expect(result.ok).toBe(true); expect(result.result.status).toBe("unique"); expect(result.result.ref).toMatch(/^rpref_[a-f0-9]{32}$/);
  await act(request, runPhantom, session.id, { type: "ref-click", ref: result.result.ref }); await expect(page.locator("output")).toHaveText("1");
  expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(1);
});

test("valid integer provenance outside calendar display range cannot crash imported evidence", async ({ page, context, request, runPhantom, targetApp }, testInfo) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => { document.body.innerHTML = '<button>Time control</button>'; });
  const capturedResponse = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/snapshots`, { data: { name: "Time control" } }); const captured = await capturedResponse.json() as SavedSemanticSnapshot;
  const exportedResponse = await request.post(`${runPhantom.url}/api/verification/snapshots/export`, { data: { ids: [captured.id] } }); const artifact = await exportedResponse.json() as PortableSnapshots; artifact.entries[0].capturedAt = Number.MAX_SAFE_INTEGER;
  const ui = await context.newPage();
  const errors: string[] = []; ui.on("pageerror", error => errors.push(error.message));
  try {
    await ui.goto(`${runPhantom.url}/verification`); const panel = ui.getByRole("region", { name: "Semantic snapshots", exact: true });
    const accepted = ui.waitForResponse(response => response.url().endsWith("/api/verification/snapshots/import") && response.request().method() === "POST");
    await panel.getByLabel("Snapshot transfer file", { exact: true }).setInputFiles({ name: "integer-time.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(artifact)) }); expect((await accepted).status()).toBe(201);
    const imported = (await (await request.get(`${runPhantom.url}/api/verification/snapshots`)).json() as SavedSemanticSnapshot[]).find(item => item.source === "imported-evidence")!; expect(imported.capturedAt).toBe(Number.MAX_SAFE_INTEGER); expect(imported.contentDigest).toBe(captured.contentDigest);
    await expect(panel.getByRole("article", { name: "Captured tree: Time control" })).toContainText("Timestamp outside display range"); expect(errors).toEqual([]);
  } catch (error) { console.info(JSON.stringify({ qualification: "F25-time-range-ui", errors })); await ui.screenshot({ path: testInfo.outputPath("f25-time-range-ui-failure.png") }); throw error; }
  finally { await ui.close(); }
});

test("touch and keyboard snapshot controls retain 44px targets, bounded reading and explicit deletion", async ({ page, browser, request, runPhantom, targetApp }, testInfo) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => { document.body.innerHTML = '<button>Touch control</button>'; });
  const capturedResponse = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/snapshots`, { data: { name: "Touch source control" } }); const captured = await capturedResponse.json() as SavedSemanticSnapshot;
  const exportedResponse = await request.post(`${runPhantom.url}/api/verification/snapshots/export`, { data: { ids: [captured.id] } }); const artifact = await exportedResponse.json() as PortableSnapshots; artifact.entries[0].name = "Imported touch control";
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); const ui = await touch.newPage();
  try {
    await ui.goto(`${runPhantom.url}/verification`); const panel = ui.getByRole("region", { name: "Semantic snapshots", exact: true });
    expect(await ui.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const chooserReady = ui.waitForEvent("filechooser"); await panel.getByRole("button", { name: "Import snapshots", exact: true }).click(); const chooser = await chooserReady;
    await chooser.setFiles({ name: "touch-transfer.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(artifact)) }); await expect(panel.getByRole("status")).toContainText("Evidence imported with new local IDs");
    const imported = (await (await request.get(`${runPhantom.url}/api/verification/snapshots`)).json() as SavedSemanticSnapshot[]).find(item => item.source === "imported-evidence")!;
    await panel.getByLabel("After snapshot", { exact: true }).selectOption(imported.id); await panel.getByRole("button", { name: "Compare snapshots", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "No observed semantic changes in the captured scope", exact: true })).toBeVisible();
    for (const control of [panel.getByLabel("Snapshot name", { exact: true }), panel.getByLabel("Before snapshot", { exact: true }), panel.getByLabel("After snapshot", { exact: true }), panel.getByRole("button", { name: "Compare snapshots", exact: true }), panel.getByRole("button", { name: "Import snapshots", exact: true })]) {
      const bounds = await control.boundingBox(); expect(bounds).not.toBeNull(); expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    const reading = panel.getByRole("region", { name: "Snapshot diff rows", exact: true }); await reading.focus(); await expect(reading).toBeFocused(); await ui.keyboard.press("ArrowDown");
    await panel.getByRole("button", { name: "Compare snapshots", exact: true }).scrollIntoViewIfNeeded();
    for (const control of [panel.getByLabel("Before snapshot", { exact: true }), panel.getByLabel("After snapshot", { exact: true }), panel.getByRole("button", { name: "Compare snapshots", exact: true }), panel.getByRole("button", { name: "Import snapshots", exact: true })]) await expect(control).toBeVisible();
    await ui.screenshot({ path: testInfo.outputPath("f25-controls-touch-390.png") });
    await ui.setViewportSize({ width: 320, height: 740 }); expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByText("Saved observations (2/100)", { exact: true }).click(); await panel.getByRole("button", { name: "Delete snapshot Imported touch control", exact: true }).click(); await expect(panel.getByRole("status")).toContainText("Snapshot deleted");
    expect((await (await request.get(`${runPhantom.url}/api/verification/snapshots`)).json() as SavedSemanticSnapshot[]).map(item => item.id)).toEqual([captured.id]); await expect(panel.getByLabel("Before snapshot", { exact: true })).toHaveValue(""); await expect(panel.getByLabel("After snapshot", { exact: true })).toHaveValue("");
  } finally { await touch.close(); }
});

test("depth-limit metadata bounds an observed oversized native tag after privacy", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => {
    document.body.innerHTML = '<button>Retained before depth cap</button>';
    let parent: Element = document.body;
    for (let index = 0; index < 70; index++) { const child = document.createElement(`bounded-${"x".repeat(300)}`); parent.append(child); parent = child; }
  });
  const response = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/snapshots`, { data: { name: "Depth coverage" } }); expect(response.status()).toBe(201);
  const output = await response.json() as SavedSemanticSnapshot;
  expect(output.tree.nodes.map(node => node.name)).toContain("Retained before depth cap"); expect(output.tree.availability).toBe("partial"); expect(output.tree.coverage.reasons).toContain("depth-limit"); expect(output.tree.coverage.reasons).toContain("summary-truncated-or-redacted"); expect(output.tree.coverage.unread.every(item => item.tag.length <= 240)).toBe(true); expect(new TextEncoder().encode(JSON.stringify(output.tree)).length).toBeLessThanOrEqual(16 * 1024);
});

test("actual capture losing every node reports unavailable comparison and never implies absence", async ({ page, context, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await page.evaluate(() => {
    document.body.innerHTML = '<button>Present before receiver metadata cap</button>';
    for (let branch = 0; branch < 16; branch++) {
      let parent: Element = document.body;
      for (let index = 0; index < 70; index++) { const child = document.createElement(`bounded-${"x".repeat(300)}`); parent.append(child); parent = child; }
    }
  });
  await expect(page.getByRole("button", { name: "Present before receiver metadata cap", exact: true })).toBeVisible();
  const response = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/snapshots`, { data: { name: "Receiver limited observation" } }); expect(response.status()).toBe(201);
  const saved = await response.json() as SavedSemanticSnapshot;
  expect(saved.tree.nodes).toEqual([]); expect(saved.tree.availability).toBe("partial"); expect(saved.tree.coverage.reasons).toContain("transport-budget-limit"); expect(saved.tree.coverage.unreadOverflow).toBe(true);
  const ui = await context.newPage();
  try {
    await ui.goto(`${runPhantom.url}/verification`); const panel = ui.getByRole("region", { name: "Semantic snapshots", exact: true });
    await panel.getByLabel("Before snapshot", { exact: true }).selectOption(saved.id); await panel.getByLabel("After snapshot", { exact: true }).selectOption(saved.id); await panel.getByRole("button", { name: "Compare snapshots", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Comparison unavailable", exact: true })).toBeVisible();
    await expect(panel.getByRole("article", { name: "Semantic snapshot comparison", exact: true })).toContainText("Unknown additions · Unknown removals · Unknown matched");
    await expect(panel.getByRole("article", { name: "Captured tree: Receiver limited observation", exact: true })).toContainText("No semantic nodes retained; this partial capture cannot establish absence.");
    await ui.setViewportSize({ width: 320, height: 740 }); expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await ui.close(); }
});
