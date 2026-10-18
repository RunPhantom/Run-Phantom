import { test, expect } from "./fixtures";
import { selectedPhysicalIndex } from "./selected-marker-observation";
import { writeFileSync } from "node:fs";
import type { BrowserSummary } from "../../../src/verification/browser-types";
test.use({ attached: true });
test("selected-tab: UI explicitly chooses opaque identical-URL tab and closes only product authority", async ({ page, backend }, info) => {
  expect(backend.external).not.toBeNull(); const external = backend.external!;
  await page.goto(backend.url + "/verification"); const panel = page.getByRole("region", { name: "Trusted browser", exact: true });
  const response = page.waitForResponse(value => value.url().endsWith("/api/verification/browser/attached-pages"));
  await panel.getByRole("button", { name: "List attached pages", exact: true }).click();
  const listing = await (await response).json() as { session: BrowserSummary; revision: string; pages: Array<{ pageId: string; origin: string }> };
  expect(listing.pages).toHaveLength(3); expect(new Set(listing.pages.map(item => item.pageId)).size).toBe(3); const twins = listing.pages.filter(item => item.origin === backend.target); expect(twins).toHaveLength(2);
  await panel.getByRole("combobox", { name: "Attached page", exact: true }).selectOption(twins[1].pageId); await panel.getByRole("button", { name: "Select attached page", exact: true }).click();
  await expect(panel).toContainText("Selected attached page");
  const chosen = (await backend.api<BrowserSummary[]>("/api/verification/browser/sessions")).body.find(item => item.id === listing.session.id)!; expect(chosen).toMatchObject({ ownership: "attached", engine: "chromium", history: "from-selection", coverage: { network: false } }); backend.sample();
  for (const [index, physical] of external.pages.entries()) { expect(physical.isClosed()).toBe(false); await expect(physical.locator(`#physical${index}`)).toHaveCount(1); }
  const checked = await backend.api<{ report: { status: string } }>(`/api/verification/browser/sessions/${chosen.id}/check`, { generation: chosen.generation, predicate: { kind: "anyOf", predicates: [{ kind: "element", selector: "#physical0", state: "present" }, { kind: "element", selector: "#physical1", state: "present" }] } });
  expect(checked.body.report.status).toBe("inconclusive");
  const observed = await backend.observe(chosen.id);
  writeFileSync(info.outputPath("actual-selected-raw-observation.json"), JSON.stringify({ listing, chosen, checked, observed }, null, 2));
  const selectedIndex = selectedPhysicalIndex(observed, { id: chosen.id, generation: chosen.generation, origin: backend.target });
  const markers = observed.events.filter(event => event.type === "dom" && ["#physical0", "#physical1"].includes(String(event.data.selector)));
  await panel.getByLabel(/^Browser control target/).fill("#pay"); await panel.getByRole("button", { name: "Send input only", exact: true }).click(); await expect(panel.getByLabel("Browser input result", { exact: true })).toContainText("Dispatch: completed · Input: trusted-browser");
  await expect(external.pages[selectedIndex].locator("#paid")).toHaveCount(1); expect(await external.pages[1 - selectedIndex].locator("#paid").count()).toBe(0); expect(await external.pages[2].locator("#paid").count()).toBe(0);
  await panel.getByRole("button", { name: "Cancel and close", exact: true }).click(); await expect(panel.getByRole("status")).toContainText("Browser authority closed");
  expect(external.browser.isConnected()).toBe(true); for (const [i, physical] of external.pages.entries()) { expect(physical.isClosed()).toBe(false); expect(await physical.locator("#result").textContent()).toBe(i === selectedIndex ? "Payment accepted" : "Original output Café 東京"); }
  expect(() => process.kill(external.pid, 0)).not.toThrow();
  const stale = await backend.api(`/api/verification/browser/sessions/${chosen.id}/action`, { generation: chosen.generation, action: { type: "click", target: { kind: "css", selector: "#pay" } } }); expect(stale.status).toBe(409);
  await page.screenshot({ path: info.outputPath("safe-explicit-selection-closed.png") }); writeFileSync(info.outputPath("actual-selected-tab.json"), JSON.stringify({ productEngine: "chromium", productVersion: external.version, productExecutable: external.executable, productExecutableSha256: external.executableSha256, uiEngine: info.project.name, listing, chosen, selectedPhysicalIndexFromActualDOMObservation: selectedIndex, markers, checked, stale, externalStillAliveBeforeHarnessCleanup: true }, null, 2));
});
