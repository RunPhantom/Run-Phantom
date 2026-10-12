import { test, expect, pairStoreApp, readStoredReport } from "./verification-store-fixture";
import { act, assertRuntime, observe } from "./verification-fixture";
import type { RelativeTarget, VerificationReport } from "../../src/verification/protocol";

test.describe("explicit query and state adapters through the actual app and SDK", () => {
  test("healthy synchronous selected state delta persists while an already-true no-op stays inconclusive", async ({ page, request, runPhantom, storeApp }, info) => {
    const session = await pairStoreApp(page, request, runPhantom, storeApp.origin);
    const target: RelativeTarget = { kind: "state", store: "shape", path: "values.count" };
    const noop = await act(request, runPhantom, session.id, { type: "causal-click", selector: "#noop", targets: [target] });
    const preexisting = await assertRuntime(request, runPhantom, session.id, { kind: "relative", target, relation: "becomes", equals: 1 }, noop, "Already held selected state");
    expect(preexisting.status).toBe("inconclusive"); expect(preexisting.reason).toContain("already held");
    const current = await assertRuntime(request, runPhantom, session.id, { kind: "state", store: "shape", path: "values.count", equals: 1 }, noop, "Standalone selected count");
    expect(current.status).toBe("pass");
    const since = await act(request, runPhantom, session.id, { type: "causal-click", selector: "#increment", targets: [target] });
    await expect(page.locator("#count")).toHaveText("2");
    const report = await assertRuntime(request, runPhantom, session.id, { kind: "relative", target, relation: "increased" }, since, "Selected count increased");
    expect(report.status).toBe("pass");
    expect(report.context?.checks[0].causal).toMatchObject({ source: "sdk-reported", attribution: "captured", readings: [{ before: { value: 1 }, after: { value: 2 } }] });
    await page.getByRole("button", { name: "Increment state", exact: true }).click();
    await expect(page.locator("#count")).toHaveText("3");
    expect(readStoredReport(runPhantom.dbPath, report.id)).toEqual({ status: report.status, evidence: report.evidence, context: report.context });
    const ui = await page.context().newPage();
    try {
      await ui.goto(`${runPhantom.url}/verification`);
      const card = ui.getByRole("article", { name: "Selected count increased: pass", exact: true });
      await expect(card).toBeVisible();
      await expect(card.getByLabel("Action transition readings")).toContainText("Before: 1 (complete)");
      await expect(card.getByLabel("Action transition readings")).toContainText("After: 2 (complete)");
      await expect(card).toContainText("SDK-reported action result");
      await card.screenshot({ path: info.outputPath("selected-state-report.png") });
      await info.attach("selected-state-report", { path: info.outputPath("selected-state-report.png"), contentType: "image/png" });
      await ui.reload(); await expect(card).toBeVisible();
      const retained = await request.get(`${runPhantom.url}/api/verification/reports`);
      expect((await retained.json() as VerificationReport[]).find(saved => saved.id === report.id)?.context).toEqual(report.context);
    } finally { await ui.close(); }
  });

  test("actual query cache exposes metadata first and selected data only after explicit application opt-in", async ({ page, request, runPhantom, storeApp }, info) => {
    const session = await pairStoreApp(page, request, runPhantom, storeApp.origin);
    const before = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/command`, { data: { type: "state", store: "queries" } });
    expect(before.ok()).toBe(true);
    const original = await before.json() as { ok: boolean; result: { value: unknown } };
    expect(original.ok).toBe(true); expect(original.result.value).toMatchObject({ queries: [{ status: "success", fetchStatus: "idle", isStale: false, hasError: false }] });
    expect(JSON.stringify(original)).not.toContain("unselected query body"); expect(JSON.stringify(original)).not.toContain('"values"');
    const cacheCursor = (await observe(request, runPhantom, session.id)).cursor;
    await page.getByRole("button", { name: "Invalidate query", exact: true }).click();
    const status = await assertRuntime(request, runPhantom, session.id, { kind: "state", store: "queries", path: "queries.0.isStale", equals: true }, cacheCursor, "Cache reports invalidation");
    await info.attach("query-invalidation-report", { body: JSON.stringify(status, null, 2), contentType: "application/json" });
    expect(status.status).toBe("pass");
    await page.getByRole("button", { name: "Expose selected query count", exact: true }).click();
    await expect(page.getByText("Selected query count exposed", { exact: true })).toBeVisible();
    const target: RelativeTarget = { kind: "state", store: "queries", path: "queries.0.values.count" };
    const since = await act(request, runPhantom, session.id, { type: "causal-click", selector: "#query-update", targets: [target] });
    await expect(page.locator("#query-count")).toHaveText("2");
    const report = await assertRuntime(request, runPhantom, session.id, { kind: "relative", target, relation: "increased" }, since, "Selected cached count increased");
    expect(report.status).toBe("pass");
    expect(report.context?.checks[0].causal?.readings[0]).toMatchObject({ before: { value: 1 }, after: { value: 2 } });
    expect(JSON.stringify(await observe(request, runPhantom, session.id))).not.toContain("unselected query body");
    expect(readStoredReport(runPhantom.dbPath, report.id).context).toEqual(report.context);
    await page.screenshot({ path: info.outputPath("selected-query-app.png") });
    await info.attach("selected-query-app", { path: info.outputPath("selected-query-app.png"), contentType: "image/png" });
  });

  test("private query identity is redacted before SDK transport, persisted reports and existing report display", async ({ page, request, runPhantom, storeApp }, info) => {
    const session = await pairStoreApp(page, request, runPhantom, storeApp.origin);
    await page.getByRole("button", { name: "Inspect private query metadata", exact: true }).click();
    await expect(page.getByText("Private key metadata registered", { exact: true })).toBeVisible();
    const response = await request.post(`${runPhantom.url}/api/verification/sessions/${session.id}/command`, { data: { type: "state", store: "private-query" } });
    expect(response.ok()).toBe(true);
    const reading = await response.json() as { ok: boolean; truncated: boolean; result: { value: unknown; availability: string } };
    expect(reading.ok).toBe(true); expect(reading.truncated).toBe(true); expect(reading.result.availability).toBe("partial");
    expect(reading.result.value).toMatchObject({ queries: [{ values: { count: 1 }, key: ["profile", { nested: { password: "[REDACTED]", apiKey: "[REDACTED]", token: "[REDACTED]" }, ordinary: "[REDACTED]" }] }] });
    const cursor = (await observe(request, runPhantom, session.id)).cursor;
    const report = await assertRuntime(request, runPhantom, session.id, { kind: "state", store: "private-query", path: "queries.0.values.count", equals: 1 }, cursor, "Private query identity remains partial");
    expect(report.status).toBe("inconclusive"); expect(report.reason).toContain("truncated or redacted");
    const serialized = JSON.stringify([reading, report, await observe(request, runPhantom, session.id), readStoredReport(runPhantom.dbPath, report.id)]);
    const privateValues = ["f23-private-password", "f23-private-api-key", "f23-private-token", `sk-proj-${"test".repeat(12)}`, "private key business body"];
    for (const value of privateValues) expect(serialized).not.toContain(value);
    const ui = await page.context().newPage();
    try {
      await ui.goto(`${runPhantom.url}/verification`);
      const card = ui.getByRole("article", { name: "Private query identity remains partial: inconclusive", exact: true });
      await expect(card).toBeVisible(); await card.getByText(/^Evidence \(/).click();
      await expect(card).toContainText("partial capture");
      for (const value of privateValues) expect(await card.innerText()).not.toContain(value);
      await card.screenshot({ path: info.outputPath("private-query-report.png") });
      await info.attach("private-query-report", { path: info.outputPath("private-query-report.png"), contentType: "image/png" });
    } finally { await ui.close(); }
  });

  test("Pinia public selected state keeps its subscription after component unmount and a local route change", async ({ page, request, runPhantom, storeApp }) => {
    const session = await pairStoreApp(page, request, runPhantom, storeApp.origin);
    const kind = await page.evaluate(() => (window as unknown as { storeFixture: { sourceKind: string } }).storeFixture.sourceKind);
    expect(kind).toBe(storeApp.realPinia ? "pinia-4.0.3/vue-3.5.43" : "pinia-shaped-app-fixture");
    await page.getByRole("button", { name: "Unmount component", exact: true }).click();
    await expect(page.getByText("Component unmounted", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Change local route", exact: true }).click();
    await expect(page.getByText("Local route changed", { exact: true })).toBeVisible();
    const target: RelativeTarget = { kind: "state", store: "pinia", path: "values.nested" };
    const since = await act(request, runPhantom, session.id, { type: "causal-click", selector: "#pinia-increment", targets: [target] });
    await expect(page.locator("#pinia-count")).toHaveText("2");
    const report = await assertRuntime(request, runPhantom, session.id, { kind: "relative", target, relation: "increased" }, since);
    expect(report.status).toBe("pass"); expect(report.context?.checks[0].causal?.readings[0]).toMatchObject({ before: { value: 2 }, after: { value: 3 } });
    const observations = await observe(request, runPhantom, session.id);
    expect(observations.events.some(event => event.type === "state" && event.data.store === "pinia")).toBe(true);
  });

  test("getter/cycle/large selected snapshots never pass and source getters are never called", async ({ page, request, runPhantom, storeApp }) => {
    const session = await pairStoreApp(page, request, runPhantom, storeApp.origin);
    for (const store of ["getter", "cycle", "large"]) {
      const cursor = (await observe(request, runPhantom, session.id)).cursor;
      const report = await assertRuntime(request, runPhantom, session.id, { kind: "state", store, path: "", equals: null }, cursor, `${store} selected snapshot unavailable`);
      expect(report.status).toBe("inconclusive");
      expect(report.reason).toContain("truncated or redacted");
      expect(report.evidence.some(event => event.type === "state" && event.truncated)).toBe(true);
    }
    expect(await page.evaluate(() => (window as unknown as { storeFixture: { stats: { getters: number } } }).storeFixture.stats.getters)).toBe(0);
    await expect(page.locator("#count")).toHaveText("1");
  });

  test("real SDK duplicate registration has one subscriber, fill privacy survives transport and disconnect releases everything", async ({ page, request, runPhantom, storeApp }) => {
    const session = await pairStoreApp(page, request, runPhantom, storeApp.origin);
    await page.evaluate(() => { (window as unknown as { storeFixture: { duplicate(): () => void } }).storeFixture.duplicate()(); });
    expect(await page.evaluate(() => (window as unknown as { storeFixture: { stats: { shapeSubscribed: number } } }).storeFixture.stats.shapeSubscribed)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { storeFixture: { rejectCredentialSelection(): { refused: boolean; reads: number } } }).storeFixture.rejectCredentialSelection())).toEqual({ refused: true, reads: 0 });
    await page.evaluate(() => (window as unknown as { storeFixture: { exposeText(): void } }).storeFixture.exposeText());
    const since = await act(request, runPhantom, session.id, { type: "fill", selector: "#text", value: "live private entered phrase" });
    const report = await assertRuntime(request, runPhantom, session.id, { kind: "state", store: "shape", path: "values.text", equals: "live private entered phrase" }, since);
    expect(report.status).toBe("inconclusive");
    expect(JSON.stringify(await observe(request, runPhantom, session.id))).not.toContain("live private entered phrase");
    expect(JSON.stringify(readStoredReport(runPhantom.dbPath, report.id))).not.toContain("live private entered phrase");
    await page.evaluate(() => (window as unknown as { storeRuntime: { disconnect(): void } }).storeRuntime.disconnect());
    const counts = await page.evaluate(() => (window as unknown as { storeFixture: { stats: Record<string, number> } }).storeFixture.stats);
    expect(counts.shapeReleased).toBe(counts.shapeSubscribed); expect(counts.queryReleased).toBe(counts.querySubscribed); expect(counts.piniaReleased).toBe(counts.piniaSubscribed);
    const disconnected = await assertRuntime(request, runPhantom, session.id, { kind: "state", store: "shape", path: "values.count", equals: 1 }, since);
    expect(disconnected.status).toBe("inconclusive");
  });

  test("document replacement refuses old causal attribution and new explicit registration observes fresh state", async ({ page, request, runPhantom, storeApp }) => {
    const session = await pairStoreApp(page, request, runPhantom, storeApp.origin);
    const target: RelativeTarget = { kind: "state", store: "shape", path: "values.count" };
    const since = await act(request, runPhantom, session.id, { type: "causal-click", selector: "#increment", targets: [target] });
    await page.goto(`${storeApp.origin}/replacement`);
    const old = await assertRuntime(request, runPhantom, session.id, { kind: "relative", target, relation: "increased" }, since);
    expect(old.status).toBe("inconclusive");
    const next = await pairStoreApp(page, request, runPhantom, storeApp.origin);
    const cursor = (await observe(request, runPhantom, next.id)).cursor;
    const fresh = await assertRuntime(request, runPhantom, next.id, { kind: "state", store: "shape", path: "values.count", equals: 1 }, cursor);
    expect(fresh.status).toBe("pass"); expect(next.id).not.toBe(session.id);
  });
});
