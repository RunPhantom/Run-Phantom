import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { startTeamFixture, type TeamFixture } from "../../tests/helpers/team-server";
import type { PromptPage, PromptRevision } from "../../src/prompts/protocol";
const test = base.extend<{ team: TeamFixture }>({ team: async ({}, use) => { const team = await startTeamFixture("prompts"); try { await use(team); } finally { await team.close(); } } });
const password = "Prompt browser passphrase 2026", evidence = path.resolve(process.env.F33_UI_ARTIFACT_ROOT ?? path.resolve(import.meta.dirname, `../../.omx/evidence/F33/connected-ui-${Date.now()}-${process.pid}/team`));
async function mutate<T>(request: APIRequestContext, url: string, endpoint: string, body?: unknown, method = "POST") {
  const session = await (await request.get(`${url}/api/team/session`)).json();
  const result = await request.fetch(`${url}/api/team${endpoint}`, { method, headers: { Origin: url, "X-RunPhantom-CSRF": session.csrfToken }, ...(body === undefined ? {} : { data: body }) });
  expect(result.ok(), await result.text()).toBe(true); return result.status() === 204 ? undefined as T : await result.json() as T;
}
async function setup(page: Page, team: TeamFixture) {
  await page.goto(`${team.url}/team`); await page.getByLabel("Setup code").fill(team.setupCode); await page.getByLabel("Email", { exact: true }).fill("owner@example.test"); await page.getByLabel("Password").fill(password); await page.getByRole("button", { name: "Create owner account", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Prompt review"); await page.getByRole("button", { name: "Create project", exact: true }).click(); await expect(page).toHaveURL(/\/team\/projects\/[^/]+$/); const project = new URL(page.url()).pathname.split("/")[3];
  await page.getByRole("link", { name: "Prompts", exact: true }).click(); await expect(page.getByRole("button", { name: "New prompt", exact: true })).toBeEnabled(); return project;
}
async function accept(page: Page, team: TeamFixture, token: string, email: string) {
  await page.goto(`${team.url}/team/invite`); await page.getByLabel("Invitation code").fill(token); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password").fill(password); await page.getByRole("button", { name: "Accept invitation", exact: true }).click(); await expect(page).toHaveURL(/\/team\/projects\/[^/]+$/); await page.getByRole("link", { name: "Prompts", exact: true }).click();
}

test("real Team prompt journey pins revisions, retains conflicts, exports literal content and fits six widths", async ({ page, team }) => {
  test.setTimeout(180_000); const errors: string[] = [], foreign: string[] = []; page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (new URL(request.url()).origin !== team.url) foreign.push(request.url()); });
  const project = await setup(page, team), base = `/projects/${project}/prompts`, template = 'Review {{topic}}.\nJSON: {"outer":{"ok":true}}';
  await page.getByLabel("Prompt name", { exact: true }).fill("Release review"); await page.getByLabel("Template", { exact: true }).fill(template);
  await page.getByRole("link", { name: "Overview", exact: true }).click(); await expect(page.getByRole("alertdialog")).toContainText("Leave unsaved changes"); await page.keyboard.press("Escape"); await expect(page).toHaveURL(/\/prompts$/); await expect(page.getByLabel("Template", { exact: true })).toHaveValue(template);
  await page.getByRole("button", { name: "Save prompt", exact: true }).click(); await expect(page.getByRole("button", { name: "Compile revision 1", exact: true })).toBeEnabled();
  const roster = await (await page.request.get(`${team.url}/api/team${base}`)).json() as PromptPage, id = roster.items[0].id;
  const source = await (await page.request.get(`${team.url}/api/team${base}/${id}/revisions/1`)).json() as PromptRevision; expect(source.template).toBe(template); expect(source.templateSha256).toBe(createHash("sha256").update(template).digest("hex"));
  const literal = '$& $$ \\ {{later}} <img src="https://untrusted.example.invalid/pixel">';
  await page.getByLabel("topic", { exact: true }).fill(literal); await page.getByRole("button", { name: "Compile revision 1", exact: true }).click(); await expect(page.getByTestId("prompt-compiled")).toHaveText(`Review ${literal}.\nJSON: {"outer":{"ok":true}}`); await expect(page.locator("img[src*='untrusted.example.invalid']")).toHaveCount(0);
  await page.getByLabel("Template", { exact: true }).fill("Second: {{topic}}"); await page.getByRole("button", { name: "Save new revision", exact: true }).click(); await expect(page.getByRole("button", { name: "Compile revision 2", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Revision 1", exact: true }).click(); await expect(page.getByLabel("Template", { exact: true })).toHaveValue(template); await expect(page.getByLabel("Template", { exact: true })).toBeDisabled();
  await page.getByLabel("topic", { exact: true }).fill(literal); await page.getByRole("button", { name: "Compile revision 1", exact: true }).click(); await expect(page.getByTestId("prompt-compiled")).toHaveText(`Review ${literal}.\nJSON: {"outer":{"ok":true}}`);
  const downloadPending = page.waitForEvent("download"); await page.getByRole("button", { name: "Export revision 1", exact: true }).click(); const exported = JSON.parse(readFileSync((await (await downloadPending).path())!, "utf8")); expect(exported.format).toBe("runphantom-prompt/v1"); expect(exported.prompt).toEqual(source);
  await page.evaluate(async () => { await document.fonts.ready; await document.fonts.load("650 30px Syne"); });
  mkdirSync(evidence, { recursive: true });
  const fontResponse = await page.request.get(`${team.url}/fonts/syne-variable.ttf`);
  writeFileSync(path.join(evidence, "font-diagnostic.json"), JSON.stringify({ status: fontResponse.status(), headers: fontResponse.headers(), bytes: (await fontResponse.body()).byteLength, faces: await page.evaluate(() => Array.from(document.fonts).map(face => ({ family: face.family, weight: face.weight, status: face.status }))), font: await page.locator(".prompt-heading h1").evaluate(element => getComputedStyle(element).fontFamily) }, null, 2));
  expect(await page.evaluate(() => document.fonts.check("650 30px Syne"))).toBe(true);
  mkdirSync(evidence, { recursive: true }); const measurements = [];
  for (const [width, height] of [[1440,900],[1280,800],[1024,768],[768,1024],[390,844],[320,740]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(evidence, `prompts-${width}.png`), fullPage: true });
    const measured = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyFont: getComputedStyle(document.querySelector(".prompt-workspace")!).fontFamily, displayFont: getComputedStyle(document.querySelector(".prompt-heading h1")!).fontFamily, accent: getComputedStyle(document.documentElement).getPropertyValue("--rp-accent").trim(), minControlHeight: Math.min(...Array.from(document.querySelectorAll(".prompt-workspace button")).map(element => element.getBoundingClientRect().height)) }));
    expect(measured.scrollWidth).toBeLessThanOrEqual(width); expect(measured.minControlHeight).toBeGreaterThanOrEqual(44); expect(measured.bodyFont).toContain("Inter"); expect(measured.displayFont).toContain("Syne"); measurements.push(measured);
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await page.getByRole("button", { name: "Load current revision", exact: true }).click(); await page.getByLabel("Template", { exact: true }).fill("Unsaved conflict draft: {{topic}}");
  await mutate(page.request, team.url, `${base}/${id}/revisions`, { operationKey: randomUUID(), name: "Another editor", template: "Concurrent {{topic}}", expectedRevision: 2 });
  await page.getByRole("button", { name: "Save new revision", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("Reload before saving"); await expect(page.getByLabel("Template", { exact: true })).toHaveValue("Unsaved conflict draft: {{topic}}");
  await page.getByRole("button", { name: "Load current revision", exact: true }).click(); await expect(page.getByRole("alertdialog")).toContainText("Discard unsaved changes"); await page.getByRole("button", { name: "Discard changes", exact: true }).click(); await expect(page.getByLabel("Template", { exact: true })).toHaveValue("Concurrent {{topic}}");
  await page.getByRole("button", { name: "Clear all prompts", exact: true }).click(); await expect(page.getByRole("alertdialog")).toContainText("This cannot be undone"); await expect(page.getByRole("button", { name: "Keep working", exact: true })).toBeFocused(); await page.keyboard.press("Shift+Tab"); await expect(page.getByRole("button", { name: "Permanently remove", exact: true })).toBeFocused(); await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Clear all prompts", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Clear all prompts", exact: true }).click(); await page.getByRole("button", { name: "Permanently remove", exact: true }).click(); await expect(page.getByText("No prompts yet. Save your first template to start its history.", { exact: true })).toBeVisible(); expect((await (await page.request.get(`${team.url}/api/team${base}`)).json()).items).toEqual([]);
  writeFileSync(path.join(evidence, "measurements.json"), JSON.stringify({ measurements, errors, foreign, provenance: "Actual authenticated Team server and SQLite; canonical12 local storage is independently activated and tested." }, null, 2)); expect(errors).toEqual([]); expect(foreign).toEqual([]);
});

test("actual viewer and editor controls remain scoped when project access is revoked", async ({ page, browser, team }) => {
  const project = await setup(page, team), base = `/projects/${project}/prompts`;
  const source = await mutate<PromptRevision>(page.request, team.url, base, { operationKey: randomUUID(), name: "Role review", template: "Role {{topic}}" });
  const viewerInvitation = await mutate<{ token: string }>(page.request, team.url, `/projects/${project}/invites`, { email: "viewer@example.test", role: "viewer" });
  const editorInvitation = await mutate<{ token: string }>(page.request, team.url, `/projects/${project}/invites`, { email: "editor@example.test", role: "editor" });
  const viewerContext = await browser.newContext(), editorContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage(); await accept(viewer, team, viewerInvitation.token, "viewer@example.test"); await viewer.getByRole("button", { name: "Role review Revision 1", exact: true }).click(); await expect(viewer.getByLabel("Template", { exact: true })).toBeDisabled(); await expect(viewer.getByRole("button", { name: "New prompt", exact: true })).toHaveCount(0); await expect(viewer.getByRole("button", { name: "Clear all prompts", exact: true })).toHaveCount(0);
    await viewer.getByLabel("topic", { exact: true }).fill("viewer literal"); await viewer.getByRole("button", { name: "Compile revision 1", exact: true }).click(); await expect(viewer.getByTestId("prompt-compiled")).toHaveText("Role viewer literal");
    const editor = await editorContext.newPage(); await accept(editor, team, editorInvitation.token, "editor@example.test"); await editor.getByRole("button", { name: "Role review Revision 1", exact: true }).click(); await expect(editor.getByLabel("Template", { exact: true })).toBeEnabled(); await expect(editor.getByRole("button", { name: "Remove prompt", exact: true })).toHaveCount(0);
    await editor.getByLabel("Template", { exact: true }).fill("Edited {{topic}}"); await editor.getByRole("button", { name: "Save new revision", exact: true }).click(); await expect(editor.getByRole("button", { name: "Compile revision 2", exact: true })).toBeEnabled();
    expect((await (await page.request.get(`${team.url}/api/team${base}/${source.id}/revisions/1`)).json()).template).toBe("Role {{topic}}");
    const members = await (await page.request.get(`${team.url}/api/team/projects/${project}/members`)).json(); const viewerId = members.items.find((member: { user: { email: string } }) => member.user.email === "viewer@example.test").user.id;
    await mutate(page.request, team.url, `/projects/${project}/members/${viewerId}`, undefined, "DELETE"); await viewer.getByRole("button", { name: "Compile revision 1", exact: true }).click(); await expect(viewer.getByTestId("prompt-compiled")).toHaveCount(0); await expect(viewer.getByLabel("Template", { exact: true })).toHaveCount(0); await expect(viewer.getByText("Return to projects", { exact: true })).toBeVisible();
  } finally { await viewerContext.close(); await editorContext.close(); }
});
