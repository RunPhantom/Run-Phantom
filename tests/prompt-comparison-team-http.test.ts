import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createTeamServer } from "../src/team/server";
import { createComparisonProviderClient } from "../src/prompts/providers";
import { COMPARISON_MODELS } from "../src/prompts/comparison-protocol";
import type { SessionResponse } from "../src/team/protocol";
interface Identity { cookie: string; csrf: string; accountId: string }
let profile: string, url: string, handle: Awaited<ReturnType<typeof createTeamServer>>, project: string, source: string;
let owner: Identity, editor: Identity, viewer: Identity, calls = 0, active = 0, peak = 0, held = false, holdHeaders = false;
let upstream: ReturnType<typeof Bun.serve>;
const release = new Set<() => void>();
const releaseHeaders = new Set<() => void>();
async function call(method: string, path: string, body?: unknown, identity?: Identity) {
  const response = await fetch(url + "/api/team" + path, { method, headers: { ...(method === "GET" ? {} : { Origin: url }), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(identity ? { Cookie: identity.cookie, "X-RunPhantom-CSRF": identity.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: response.status === 204 ? undefined : await response.json() };
}
function identity(response: Response, session: SessionResponse): Identity {
  if (!session.authenticated || !response.headers.get("set-cookie")) throw new Error("Native authentication unavailable");
  return { cookie: response.headers.get("set-cookie")!.split(";")[0], csrf: session.csrfToken, accountId: session.user.id };
}
async function until(condition: () => boolean, timeout = 3000) { const end = performance.now() + timeout; while (!condition()) { if (performance.now() >= end) throw new Error("Native comparison control did not settle"); await Bun.sleep(5); } }
beforeAll(async () => {
  profile = realpathSync(mkdtempSync(join(tmpdir(), "rp-comparison-team-http-"))); const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve())); url = `http://127.0.0.1:${port}`;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages: { content: string }[] }; calls++; active++; peak = Math.max(peak, active);
    expect(body.messages[0].content).toBe("Native $& {{literal}}"); let done = false;
    if (holdHeaders) await new Promise<void>(resolve => { const finish = () => { releaseHeaders.delete(finish); resolve(); }; releaseHeaders.add(finish); });
    const finish = () => { if (!done) { done = true; active--; } };
    return new Response(new ReadableStream({ start(controller) {
      const send = () => { release.delete(send); if (done) return;
        const raw = body.model.startsWith("gpt") ? { model: body.model, service_tier: "default", choices: [{ message: { content: "Native answer <img>" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } }
          : { model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: "Native answer <img>" }], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: "global", service_tier: "standard" } };
        controller.enqueue(new TextEncoder().encode(JSON.stringify(raw))); controller.close(); finish(); };
      if (held) release.add(send); else setTimeout(send, 20);
    }, cancel() { finish(); } }));
  } });
  const client = createComparisonProviderClient({ credentials: { openai: "fixture-token", anthropic: "fixture-token" }, transport: (_url, init) => fetch(upstream.url, holdHeaders ? { ...init, signal: undefined } : init), provenance: "controlled-http-fixture" });
  const bootstrapCode = randomBytes(32).toString("base64url");
  handle = await createTeamServer({ port, bindHost: "127.0.0.1", publicOrigin: url, trustedProxyIps: [], dataDir: join(profile, "team"), bootstrapCode }, { uiDir: profile, comparisons: { client, budgets: { openai: 1000000, anthropic: 1000000 } } });
  await new Promise<void>(resolve => handle.server.listen(port, "127.0.0.1", resolve));
  const setup = await call("POST", "/setup", { setupCode: bootstrapCode, email: "owner@example.test", password: "actual owner password" }); expect(setup.response.status).toBe(201); owner = identity(setup.response, setup.data);
  const created = await call("POST", "/projects", { name: "Actual model comparisons" }, owner); expect(created.response.status).toBe(201); project = created.data.id;
  for (const role of ["editor", "viewer"] as const) {
    const invitation = await call("POST", `/projects/${project}/invites`, { email: role + "@example.test", role }, owner); expect(invitation.response.status).toBe(201);
    const accepted = await call("POST", "/invites/accept", { token: invitation.data.token, email: role + "@example.test", password: "actual member password" }); expect(accepted.response.status).toBe(201);
    const member = identity(accepted.response, accepted.data.session); if (role === "editor") editor = member; else viewer = member;
  }
  const saved = await call("POST", `/projects/${project}/prompts`, { operationKey: randomUUID(), name: "Native frozen", template: "Native {{topic}}" }, editor); expect(saved.response.status).toBe(201); source = saved.data.id;
});
afterAll(async () => { for (const send of [...releaseHeaders]) send(); for (const send of [...release]) send(); await handle?.close(); await upstream?.stop(true); if (profile) rmSync(profile, { recursive: true, force: true }); });
const base = () => `/projects/${project}/prompts/comparisons`;
async function input() { const cap = await call("GET", base() + "/capabilities", undefined, editor); expect(cap.response.status).toBe(200); return { operationKey: randomUUID(), promptId: source, revision: 1, variables: { topic: "$& {{literal}}" }, targets: [...COMPARISON_MODELS], options: { maxOutputTokens: 128, temperature: 0 }, operationBudgetMicrousd: 1000000, expectedGeneration: cap.data.generation }; }
test("real authenticated editor executes all four bounded targets through native HTTP and same-key retry never redispatches", async () => {
  const value = await input(), first = await call("POST", base(), value, editor); expect(first.response.status).toBe(201); const before = calls;
  const retry = await call("POST", base(), value, editor); expect(retry.response.status).toBe(201); expect(retry.data.id).toBe(first.data.id);
  let result = first;
  await until(() => calls === 4);
  for (let index = 0; index < 100; index++) { result = await call("GET", base() + "/" + first.data.id, undefined, viewer); if (result.data.attempts.every((row: { status: string }) => row.status === "completed")) break; await Bun.sleep(5); }
  expect(result.response.status).toBe(200); expect(result.data.request.compiled).toBe("Native $& {{literal}}"); expect(result.data.attempts).toHaveLength(4); expect(result.data.attempts.every((row: { status: string; payload: { output: string; provenance: string; invoiceUsd: null } }) => row.status === "completed" && row.payload.output === "Native answer <img>" && row.payload.provenance === "controlled-http-fixture" && row.payload.invoiceUsd === null)).toBe(true);
  expect(calls).toBe(4); expect(before).toBeLessThanOrEqual(2); expect(peak).toBe(2);
  const page = await call("GET", base(), undefined, viewer); expect(page.data.items).toHaveLength(1); expect(JSON.stringify(page.data)).not.toContain("Native answer"); expect(JSON.stringify(page.data)).not.toContain('"compiled"');
});
test("viewer cannot spend, editor cannot clear, and raw duplicate/foreign/CSRF refusals leave all comparison rows exact", async () => {
  const value = await input(), db = new Database(join(profile, "team/team.sqlite"), { readonly: true });
  const snapshot = () => ["comparison_scope_controls", "prompt_comparisons", "prompt_comparison_attempts"].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  try {
    const before = snapshot(); expect((await call("POST", base(), value, viewer)).response.status).toBe(403);
    expect((await call("POST", base() + "/clear", { operationKey: randomUUID(), expectedGeneration: value.expectedGeneration, confirmRemoval: true }, editor)).response.status).toBe(403);
    for (const [headers, body, expected] of [
      [{ Origin: url, Cookie: editor.cookie, "X-RunPhantom-CSRF": editor.csrf }, '{"operationKey":"a","operationKey":"b"}', 400],
      [{ Origin: url, Cookie: editor.cookie, "X-RunPhantom-CSRF": editor.csrf }, '{"variables":{"topic":"a","to\\u0070ic":"b"}}', 400],
      [{ Origin: "https://foreign.invalid", Cookie: editor.cookie, "X-RunPhantom-CSRF": editor.csrf }, JSON.stringify(value), 403],
      [{ Origin: url, Cookie: editor.cookie }, JSON.stringify(value), 403],
    ] as const) {
      const response = await fetch(url + "/api/team" + base(), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }); expect(response.status).toBe(expected); await response.arrayBuffer();
    }
    expect(snapshot()).toEqual(before); expect(calls).toBe(4); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
test("owner comparison-only clear advances just its epoch and preserves saved prompts and retained accounting", async () => {
  const original = await call("GET", `/projects/${project}/prompts/${source}/revisions/1`, undefined, owner), cap = await call("GET", base() + "/capabilities", undefined, owner);
  const cleared = await call("POST", base() + "/clear", { operationKey: randomUUID(), expectedGeneration: cap.data.generation, confirmRemoval: true }, owner); expect(cleared.response.status).toBe(200); expect(cleared.data.generation).toBe(cap.data.generation + 1);
  const page = await call("GET", base(), undefined, viewer); expect(page.data.items[0].tombstone).toBe(true); expect(page.data.items[0].prompt).toBeNull(); expect(page.data.items[0].attempts.every((row: { chargeMicrousd: number; status: string }) => row.status === "completed" && row.chargeMicrousd > 0)).toBe(true);
  expect((await call("GET", `/projects/${project}/prompts/${source}/revisions/1`, undefined, owner)).data).toEqual(original.data); expect(calls).toBe(4);
});
test("actual editor-to-viewer downgrade retires held native requests before output and keeps read access without late publication", async () => {
  held = true; const value = await input(), operation = await call("POST", base(), value, editor); expect(operation.response.status).toBe(201); await until(() => calls === 6);
  const changed = await call("PATCH", `/projects/${project}/members/${editor.accountId}`, { role: "viewer" }, owner); expect(changed.response.status).toBe(200);
  let receipt = operation.data, retired = false;
  const end = performance.now() + 1200;
  while (performance.now() < end) { const read = await call("GET", base() + "/" + operation.data.id, undefined, editor); expect(read.response.status).toBe(200); receipt = read.data; if (receipt.attempts.every((row: { status: string }) => row.status === "authority_lost")) { retired = true; break; } await Bun.sleep(15); }
  expect(retired).toBe(true); expect(receipt.attempts.every((row: { payload: unknown }) => row.payload === null)).toBe(true); expect(receipt.attempts.slice(0, 2).every((row: { chargeMicrousd: number; reserveMicrousd: number }) => row.chargeMicrousd === row.reserveMicrousd && row.chargeMicrousd > 0)).toBe(true);
  for (const send of [...release]) send(); await Bun.sleep(50); expect((await call("GET", base() + "/" + operation.data.id, undefined, viewer)).data).toEqual(receipt); expect(calls).toBe(6);
});
test("every concurrent native Team close caller joins actual transport settlement instead of returning early", async () => {
  held = false; holdHeaders = true; const value = await input(), operation = await call("POST", base(), value, owner); expect(operation.response.status).toBe(201); await until(() => releaseHeaders.size === 2);
  let firstDone = false, secondDone = false; const first = handle.close().then(() => { firstDone = true; }), second = handle.close().then(() => { secondDone = true; });
  try {
    await Bun.sleep(60); expect(firstDone).toBe(false); expect(secondDone).toBe(false);
  } finally { for (const send of [...releaseHeaders]) send(); await Promise.all([first, second]); }
  expect(firstDone).toBe(true); expect(secondDone).toBe(true);
});
