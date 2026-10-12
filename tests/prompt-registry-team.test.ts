import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { createTeamServer } from "../src/team/server";
import { loadTeamConfig } from "../src/team/config";
import { initializeTeamSchema } from "../src/team/store-schema";
import type { Project, SessionResponse } from "../src/team/protocol";
import type { PromptRevision, PromptPage } from "../src/prompts/protocol";

interface Identity { cookie: string; csrf: string; userId: string }
const draft = (template = "Hello {{who}}") => ({ operationKey: randomUUID(), name: "Greeting", template });
async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-prompts-http-")), setupCode = "rp_team_setup_" + "s".repeat(43);
  const config = { ...loadTeamConfig({}), dataDir: directory, bootstrapCode: setupCode };
  let handle = await createTeamServer(config, { uiDir: directory });
  async function listen() {
    await new Promise<void>(resolve => handle.server.listen(0, "127.0.0.1", resolve));
    const address = handle.server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    return `http://127.0.0.1:${address.port}`;
  }
  let url = await listen();
  async function call<T = unknown>(method: string, endpoint: string, body?: unknown, who?: Identity, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { Host: new URL(config.publicOrigin).host };
    if (method !== "GET") headers.Origin = config.publicOrigin;
    if (who) { headers.Cookie = who.cookie; headers["X-RunPhantom-CSRF"] = who.csrf; }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url + endpoint, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, value: (text ? JSON.parse(text) : null) as T, text };
  }
  function identity(result: { headers: Headers; value: SessionResponse }): Identity {
    if (!result.value.authenticated) throw new Error("Fixture authentication failed");
    return { cookie: result.headers.get("set-cookie")!.split(";")[0], csrf: result.value.csrfToken!, userId: result.value.user.id };
  }
  const owner = identity(await call<SessionResponse>("POST", "/api/team/setup", { setupCode, email: "owner@example.test", password: "correct horse battery" }));
  const project = (await call<Project>("POST", "/api/team/projects", { name: "Prompt project" }, owner)).value;
  const base = `/api/team/projects/${project.id}/prompts`;
  async function member(role: "editor" | "viewer") {
    const email = `${role}@example.test`, invite = (await call<{ token: string }>("POST", `/api/team/projects/${project.id}/invites`, { email, role }, owner)).value;
    const accepted = await call<{ session: SessionResponse }>("POST", "/api/team/invites/accept", { token: invite.token, email, password: "member horse battery" });
    return identity({ headers: accepted.headers, value: accepted.value.session });
  }
  function sql(query: string, ...args: string[]): unknown {
    const database = new Database(path.join(directory, "team.sqlite"), { readonly: true });
    try { return database.query(query).get(...args); } finally { database.close(); }
  }
  async function restart() { await handle.close(); handle = await createTeamServer(config, { uiDir: directory }); url = await listen(); }
  function held(endpoint: string, body: unknown, who: Identity) {
    const bytes = Buffer.from(JSON.stringify(body)), split = Math.floor(bytes.byteLength / 2);
    let upload!: ReturnType<typeof httpRequest>;
    const result = new Promise<{ status: number; text: string }>((resolve, reject) => {
      upload = httpRequest(url + endpoint, { method: "POST", headers: { Host: new URL(config.publicOrigin).host, Origin: config.publicOrigin,
        Cookie: who.cookie, "X-RunPhantom-CSRF": who.csrf, "Content-Type": "application/json", "Content-Length": bytes.byteLength } }, response => {
        let text = ""; response.on("data", (part: Buffer) => { text += part.toString(); }); response.on("end", () => resolve({ status: response.statusCode!, text }));
      });
      upload.on("error", reject); upload.write(bytes.subarray(0, split));
    });
    return { result, finish: () => upload.end(bytes.subarray(split)) };
  }
  return { get handle() { return handle; }, get url() { return url; }, config, call, owner, project, base, member, sql, restart, held,
    close: async () => { await handle.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function captured(spy: ReturnType<typeof spyOn>, initial: number) {
  const deadline = Date.now() + 3000;
  while (spy.mock.calls.length <= initial && Date.now() < deadline) await Bun.sleep(5);
  expect(spy.mock.calls.length).toBeGreaterThan(initial);
}

test("actual Team cookie/CSRF roles preserve immutable prompt history across restart and report clear", async () => {
  const f = await fixture();
  try {
    const editor = await f.member("editor"), viewer = await f.member("viewer");
    expect((await f.call("GET", f.base + "/capabilities")).status).toBe(401);
    expect((await f.call("POST", f.base, draft(), editor, { "X-RunPhantom-CSRF": "invalid" })).status).toBe(403);
    expect((await f.call("POST", f.base, draft(), viewer)).status).toBe(403);
    const input = draft(), first = await f.call<PromptRevision>("POST", f.base, input, editor);
    expect(first.status).toBe(201);
    const revision = await f.call<PromptRevision>("POST", `${f.base}/${first.value.id}/revisions`, { ...draft("Later"), expectedRevision: 1 }, editor);
    expect(revision.value.revision).toBe(2);
    expect((await f.call("POST", `${f.base}/${first.value.id}/revisions/1/compile`, { variables: { who: "$& {{nested}} 🦊" } }, viewer)).value).toMatchObject({ compiled: "Hello $& {{nested}} 🦊", revision: 1 });
    expect((await f.call("DELETE", `${f.base}/${first.value.id}?expectedRevision=2`, undefined, editor)).status).toBe(403);
    expect((await f.call("GET", `${f.base}/${first.value.id}/revisions/1/export`, undefined, viewer)).value).toMatchObject({ prompt: first.value });
    expect((await f.call("DELETE", `/api/team/projects/${f.project.id}/evidence/all`, undefined, f.owner)).status).toBe(200);
    await f.restart();
    expect((await f.call("GET", `${f.base}/${first.value.id}/revisions/1`, undefined, viewer)).value).toEqual(first.value);
    expect((await f.call("POST", f.base, input, editor)).value).toEqual(first.value);
    expect((await f.call("POST", `${f.base}/${first.value.id}/revisions`, { ...draft(), expectedRevision: 1 }, editor)).status).toBe(409);
    expect((await f.call("DELETE", `${f.base}/${first.value.id}?expectedRevision=2`, undefined, f.owner)).status).toBe(200);
    expect((await f.call("POST", f.base, input, editor)).status).toBe(409);
    expect(f.sql("SELECT count(*) AS n FROM prompt_revisions")).toEqual({ n: 0 });
  } finally { await f.close(); }
});
test("actual Team project/credential/revision/body boundaries refuse without local fallback", async () => {
  const f = await fixture();
  try {
    const first = (await f.call<PromptRevision>("POST", f.base, draft(), f.owner)).value;
    const other = (await f.call<Project>("POST", "/api/team/projects", { name: "Other" }, f.owner)).value;
    expect((await f.call("GET", `/api/team/projects/${other.id}/prompts/${first.id}/revisions/1`, undefined, f.owner)).status).toBe(404);
    for (const revision of ["0", "01", "33", "NaN"]) expect((await f.call("GET", `${f.base}/${first.id}/revisions/${revision}`, undefined, f.owner)).status).toBe(400);
    expect((await f.call("GET", `${f.base}/${first.id}/revisions/2`, undefined, f.owner)).status).toBe(404);
    expect((await f.call("GET", f.base + "?cursor=x&cursor=y", undefined, f.owner)).status).toBe(400);
    expect((await f.call("POST", f.base, { ...draft(), database: "override" }, f.owner)).status).toBe(400);
    expect((await f.call("POST", f.base, draft("password=synthetic-password"), f.owner)).text).not.toContain("synthetic-password");
    expect((await f.call("POST", f.base, draft("🦊".repeat(20000)), f.owner)).status).toBe(413);
    const headers = { Host: new URL(f.config.publicOrigin).host, Origin: f.config.publicOrigin, Cookie: f.owner.cookie, "X-RunPhantom-CSRF": f.owner.csrf, "Content-Type": "application/json" };
    for (const body of ['{"name":"first","name":"duplicate"}', '{"name":"\ud800"}', '{"a":9007199254740993}', "[[]]"]) {
      const response = await fetch(f.url + f.base, { method: "POST", headers, body }); expect(response.status).toBe(400);
    }
    expect((await f.call<PromptPage>("GET", f.base, undefined, f.owner)).value.items).toHaveLength(1);
  } finally { await f.close(); }
});
test("paused actual Team body refuses editor downgrade and prompt-clear generation change before mutation", async () => {
  const f = await fixture();
  try {
    const editor = await f.member("editor"), spy = spyOn(f.handle.store, "promptGeneration");
    try {
      let before = spy.mock.calls.length; const downgraded = f.held(f.base, draft("blocked downgrade"), editor);
      await captured(spy, before);
      expect((await f.call("PATCH", `/api/team/projects/${f.project.id}/members/${editor.userId}`, { role: "viewer" }, f.owner)).status).toBe(200);
      downgraded.finish(); expect((await downgraded.result).status).toBe(403);
      expect((await f.call("PATCH", `/api/team/projects/${f.project.id}/members/${editor.userId}`, { role: "editor" }, f.owner)).status).toBe(200);
      before = spy.mock.calls.length; const stale = f.held(f.base, draft("blocked generation"), editor);
      await captured(spy, before);
      const capabilities = (await f.call<{ generation: number }>("GET", f.base + "/capabilities", undefined, f.owner)).value;
      const cleared = await f.call<{ generation: number }>("POST", f.base + "/clear", { expectedGeneration: capabilities.generation, operationKey: randomUUID() }, f.owner);
      expect(cleared.status).toBe(200); expect(cleared.value.generation).toBe(capabilities.generation + 1);
      stale.finish(); expect((await stale.result).status).toBe(409);
      expect(f.sql("SELECT count(*) AS n FROM prompt_heads")).toEqual({ n: 0 });
    } finally { spy.mockRestore(); }
  } finally { await f.close(); }
});
test("paused actual Team compile loses session authority and does not publish output", async () => {
  const f = await fixture();
  try {
    const viewer = await f.member("viewer"), first = (await f.call<PromptRevision>("POST", f.base, draft(), f.owner)).value;
    const spy = spyOn(f.handle.store, "promptGeneration");
    try {
      const before = spy.mock.calls.length, pending = f.held(`${f.base}/${first.id}/revisions/1/compile`, { variables: { who: "private-output-canary" } }, viewer);
      await captured(spy, before);
      expect((await f.call("POST", "/api/team/logout", {}, viewer)).status).toBe(204);
      pending.finish(); const response = await pending.result;
      expect(response.status).toBe(401); expect(response.text).not.toContain("private-output-canary");
    } finally { spy.mockRestore(); }
  } finally { await f.close(); }
});
test("genuine frozen Team v2 upgrades atomically to v3, preserves exact old rows and refuses altered schemas", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-prompts-v2-")), filename = path.join(directory, "team.sqlite");
  let database = new Database(filename);
  try {
    database.exec("PRAGMA foreign_keys=ON"); database.exec(readFileSync(`${import.meta.dir}/fixtures/prompt-registry-team-v2.sql`, "utf8"));
    database.exec("INSERT INTO projects(id,name,created_at) VALUES('historical-project','Preserved',1); UPDATE evaluation_evidence_scopes SET generation=7 WHERE scope_key='project:historical-project'; INSERT INTO evaluation_evidence_inventory_heads VALUES('project:historical-project','retained',0)");
    const old = database.query("SELECT * FROM evaluation_evidence_scopes").all(), projects = database.query("SELECT * FROM projects").all();
    initializeTeamSchema(database); database.close(); database = new Database(filename); database.exec("PRAGMA foreign_keys=ON"); initializeTeamSchema(database);
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(database.query("SELECT * FROM evaluation_evidence_scopes").all()).toEqual(old);
    expect(database.query("SELECT * FROM projects").all()).toEqual(projects);
    expect(database.query("SELECT id FROM evaluation_evidence_inventory_heads").all()).toEqual([{ id: "retained" }]);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    database.exec("DROP TRIGGER prompt_revision_immutable");
    const schema = database.query("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    expect(() => initializeTeamSchema(database)).toThrow("supported team schema");
    expect(database.query("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an interrupted v2 prompt upgrade rolls back new tables and leaves the original database reopenable", () => {
  const database = new Database(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON"); database.exec(readFileSync(`${import.meta.dir}/fixtures/prompt-registry-team-v2.sql`, "utf8"));
    database.exec("INSERT INTO projects(id,name,created_at) VALUES('rollback-project','Original project',1)");
    const before = database.query("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    const original = database.exec.bind(database), execution = spyOn(database, "exec").mockImplementation((sql: string) => {
      original(sql); if (sql.includes("CREATE TABLE prompt_heads")) throw new Error("Controlled upgrade interruption");
    });
    try { expect(() => initializeTeamSchema(database)).toThrow("Controlled upgrade interruption"); } finally { execution.mockRestore(); }
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(database.query("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(database.query("SELECT name FROM projects").get()).toEqual({ name: "Original project" });
    initializeTeamSchema(database);
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(database.query("SELECT name FROM projects").get()).toEqual({ name: "Original project" });
  } finally { database.close(); }
});
