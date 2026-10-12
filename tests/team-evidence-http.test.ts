import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { createTeamServer } from "../src/team/server";
import { loadTeamConfig } from "../src/team/config";
import { EVIDENCE_READER_IDENTITY, EVIDENCE_IMPORT_CONTENT_TYPE } from "../src/evaluations/evidence-import";
import { canonicalEvidenceJson, evidenceDigest } from "../src/evaluations/evidence-validation";
import { parseExternalEvidence } from "../src/evaluations/external-evidence";
import { evidenceExportJUnit } from "../src/evaluations/evidence-export";

interface Identity { cookie: string; csrf: string; userId: string }
const runId = "1".repeat(32), spanId = "2".repeat(16);
const sourceBytes = new TextEncoder().encode('<testsuite tests="1"><testcase name="Actual Team report" time="0"/></testsuite>');
async function fixture() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "team-evidence-http-"));
  const setupCode = "rp_team_setup_" + "s".repeat(43);
  const config = { ...loadTeamConfig({}), dataDir: directory, bootstrapCode: setupCode };
  let handle = await createTeamServer(config, { uiDir: directory });
  await new Promise<void>(resolve => handle.server.listen(0, "127.0.0.1", resolve));
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  let url = `http://127.0.0.1:${address.port}`;
  async function call(method: string, endpoint: string, body?: unknown, identity?: Identity, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { Host: new URL(config.publicOrigin).host };
    if (method !== "GET") headers.Origin = config.publicOrigin;
    if (identity) { headers.Cookie = identity.cookie; headers["X-RunPhantom-CSRF"] = identity.csrf; }
    let data: BodyInit | undefined;
    if (body instanceof Uint8Array) data = body;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; data = JSON.stringify(body); }
    Object.assign(headers, extra);
    const response = await fetch(url + endpoint, { method, headers, body: data, redirect: "manual" });
    const text = await response.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* Explicit raw export controls inspect text. */ }
    return { status: response.status, headers: response.headers, json, text };
  }
  function identity(result: Awaited<ReturnType<typeof call>>): Identity {
    const session = result.json.authenticated ? result.json : result.json.session;
    return { cookie: result.headers.get("set-cookie")!.split(";")[0], csrf: session.csrfToken, userId: session.user.id };
  }
  const owner = identity(await call("POST", "/api/team/setup", { setupCode, email: "owner@example.test", password: "correct horse battery" }));
  const project = (await call("POST", "/api/team/projects", { name: "Evidence project" }, owner)).json;
  const base = `/api/team/projects/${project.id}/evidence`;
  async function member(role: "editor" | "viewer") {
    const email = `${role}@example.test`;
    const invite = (await call("POST", `/api/team/projects/${project.id}/invites`, { email, role }, owner)).json;
    return identity(await call("POST", "/api/team/invites/accept", { token: invite.token, email, password: "member horse battery" }));
  }
  async function capture(id = runId) {
    const key = (await call("POST", `/api/team/projects/${project.id}/keys`, { label: "Actual exporter" }, owner)).json;
    const traces = { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: id, spanId, name: "Preserved captured run", startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000001000000000", status: { code: 1 }, attributes: [{ key: "runphantom.output", value: { stringValue: "Exact captured output" } }] }] }] }] };
    expect((await call("POST", "/api/team/ingest/v1/traces", traces, undefined, { Authorization: `Bearer ${key.token}` })).status).toBe(200);
    return key;
  }
  function frame(operationKey: string, options: Record<string, unknown> = {}, bytes: Uint8Array[] = [sourceBytes]) {
    const header = Buffer.from(JSON.stringify({ version: 1, request: { ...EVIDENCE_READER_IDENTITY, operationKey, target: null, attachment: { kind: "run", id: runId },
      sources: [{ sourceId: "report-1", shardId: "unit", kind: "junit", dialect: "junit-xml/v1", artifactSha256: evidenceDigest(sourceBytes), byteLength: sourceBytes.byteLength }], inventory: null, retention: "raw_and_normalized", ...options } }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.byteLength);
    return Buffer.concat([length, header, ...bytes]);
  }
  async function completed(id: string, who = owner) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await call("GET", `${base}/imports/${id}`, undefined, who);
      if (response.status !== 200 || !["queued", "running"].includes(response.json.job.status)) return response;
      await Bun.sleep(100);
    }
    throw new Error("Actual Team import did not terminate");
  }
  const sql = (query: string, ...args: string[]) => {
    const db = new Database(path.join(directory, "team.sqlite"), { readonly: true });
    try { return db.query(query).get(...args); } finally { db.close(); }
  };
  const mutate = (query: string, ...args: (string | number)[]) => {
    const db = new Database(path.join(directory, "team.sqlite"));
    try { return db.query(query).run(...args); } finally { db.close(); }
  };
  const restart = async () => {
    await handle.close();
    handle = await createTeamServer(config, { uiDir: directory });
    await new Promise<void>(resolve => handle.server.listen(0, "127.0.0.1", resolve));
    const next = handle.server.address(); if (!next || typeof next === "string") throw new Error("Missing restarted listener");
    url = `http://127.0.0.1:${next.port}`;
  };
  function held(operationKey: string, who = owner, endpoint = base + "/imports", bytes = frame(operationKey), split = bytes.byteLength - sourceBytes.byteLength, contentType = EVIDENCE_IMPORT_CONTENT_TYPE) {
    let upload!: ReturnType<typeof httpRequest>;
    const result = new Promise<number>((resolve, reject) => {
      upload = httpRequest(url + endpoint, { method: endpoint.endsWith("/inventories") ? "PUT" : "POST", headers: { Host: new URL(config.publicOrigin).host, Origin: config.publicOrigin, Cookie: who.cookie, "X-RunPhantom-CSRF": who.csrf, "Content-Type": contentType, "Content-Length": bytes.byteLength } }, response => { response.resume(); resolve(response.statusCode!); });
      upload.on("error", reject); upload.write(bytes.subarray(0, split));
    }).then(status => status, () => 0);
    return { upload, result, finish: () => upload.end(bytes.subarray(split)) };
  }
  async function admitted(operationKey: string) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const row = sql("SELECT id,status FROM evaluation_evidence_jobs WHERE operation_key=?", operationKey) as { id: string; status: string } | null;
      if (row) return row;
      await Bun.sleep(5);
    }
    throw new Error("Held frame did not acquire metadata");
  }
  return { get handle() { return handle; }, get url() { return url; }, directory, config, call, owner, project, base, member, capture, frame, completed, sql, mutate, restart, held, admitted,
    close: async () => { await handle.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("Team evidence capabilities authenticate and derive current roles", async () => {
  const f = await fixture();
  try {
    expect((await f.call("GET", `${f.base}/capabilities`)).status).toBe(401);
    const capabilities = await f.call("GET", `${f.base}/capabilities`, undefined, f.owner);
    expect(capabilities.status).toBe(200);
    expect(capabilities.headers.get("cache-control")).toBe("no-store");
    expect(capabilities.json.access).toEqual(["normalized_read", "import", "inventory_edit", "raw_export", "delete"]);
    const editor = await f.member("editor"), viewer = await f.member("viewer");
    expect((await f.call("GET", `${f.base}/capabilities`, undefined, editor)).json.access).toEqual(["normalized_read", "import"]);
    expect((await f.call("GET", `${f.base}/capabilities`, undefined, viewer)).json.access).toEqual(["normalized_read"]);
    expect((await f.call("DELETE", f.base + "/all", undefined, viewer)).status).toBe(403);
    expect((await f.call("PUT", f.base + "/inventories", {}, editor)).status).toBe(403);
    await f.call("DELETE", `/api/team/projects/${f.project.id}/members/${editor.userId}`, undefined, f.owner);
    expect((await f.call("GET", `${f.base}/capabilities`, undefined, editor)).status).toBe(404);
  } finally { await f.close(); }
});

test("Team report import persists exact output separately from captured counters and cannot cross projects", async () => {
  const f = await fixture();
  try {
    const key = await f.capture(), editor = await f.member("editor"), viewer = await f.member("viewer");
    const before = f.sql("SELECT evidence_bytes,run_count,span_count,check_count FROM projects WHERE id=?", f.project.id);
    expect((await f.call("GET", `${f.base}/capabilities`, undefined, undefined, { Authorization: `Bearer ${key.token}` })).status).toBe(401);
    const upload = await f.call("POST", `${f.base}/imports`, f.frame("actual-output"), editor, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
    expect(upload.status).toBe(202);
    const done = await f.completed(upload.json.job.id);
    expect(done.status).toBe(200); expect(done.json.job.status).toBe("completed");
    const setId = done.json.job.setId;
    const detail = await f.call("GET", `${f.base}/sets/${setId}?revision=1`, undefined, viewer);
    expect(detail.status).toBe(200);
    expect(detail.json.revision.scope).toEqual({ kind: "project", id: f.project.id });
    expect(detail.json.revision.coverage).toBe("not_declared");
    expect(detail.json.revision.sources[0]).toMatchObject({ reportOutcome: "reports_pass", authentication: "not_checked" });
    expect(detail.json.sources[0].normalized.leaves[0]).toMatchObject({ name: "Actual Team report", durationMs: 0 });
    expect((await f.call("GET", `${f.base}/sets/${setId}/raw/report-1?revision=1`, undefined, viewer)).status).toBe(403);
    expect((await f.call("GET", `${f.base}/sets/${setId}/raw/report-1?revision=1`, undefined, f.owner)).text).toBe(new TextDecoder().decode(sourceBytes));
    const retry = await f.call("POST", `${f.base}/imports`, f.frame("actual-output"), editor, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
    expect(retry.status).toBe(202); expect(retry.json.reused).toBe(true); expect(retry.json.job.id).toBe(upload.json.job.id);
    const second = (await f.call("POST", "/api/team/projects", { name: "Unrelated project" }, f.owner)).json;
    expect((await f.call("GET", `/api/team/projects/${second.id}/evidence/sets/${setId}?revision=1`, undefined, f.owner)).status).toBe(404);
    expect(f.sql("SELECT evidence_bytes,run_count,span_count,check_count FROM projects WHERE id=?", f.project.id)).toEqual(before);
    expect((await f.call("GET", `/api/team/projects/${f.project.id}/runs/${runId}/spans/${spanId}`, undefined, f.owner)).json.outputPayload).toBe("Exact captured output");
  } finally { await f.close(); }
});


test("Team evidence controls preserve full32-source inventories and strict64KiB UTF8 boundaries", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const expected = Array.from({ length: 32 }, (_, index) => ({ shardId: "s".repeat(124) + String(index).padStart(4, "0"), kind: "junit", constraints: { runnerId: "r".repeat(128), commit: "c".repeat(256), sourceSha256: "a".repeat(64) } }));
    const body = JSON.stringify({ anchor: { kind: "run", id: runId }, expectedRevision: 0, expected });
    expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024);
    const exact = Buffer.from(body + " ".repeat(65536 - Buffer.byteLength(body)));
    const saved = await f.call("PUT", f.base + "/inventories", exact, f.owner, { "Content-Type": "application/json" });
    expect(saved.status).toBe(201); expect(saved.json.expected).toEqual(expected);
    expect((await f.call("PUT", f.base + "/inventories", Buffer.concat([exact, Buffer.from(" ")]), f.owner, { "Content-Type": "application/json" })).status).toBe(413);
    for (const raw of ['{"anchor":{},"anchor":{}}', '{"x":' + '['.repeat(17) + '0' + ']'.repeat(17) + '}', Buffer.from([0xc3, 0x28])]) {
      expect((await f.call("PUT", f.base + "/inventories", Buffer.from(raw), f.owner, { "Content-Type": "application/json" })).status).toBe(400);
    }
    const anchor = new URLSearchParams({ anchor: JSON.stringify({ kind: "run", id: runId }) });
    expect((await f.call("GET", f.base + "/inventories?" + anchor.toString(), undefined, f.owner)).json).toEqual(saved.json);
    expect((await f.call("PUT", f.base + "/inventories", { anchor: { kind: "run", id: runId }, expectedRevision: 0, expected }, f.owner)).status).toBe(409);
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_inventories")).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("Team evidence route authority and closed query/media negatives do not acquire sources", async () => {
  const f = await fixture();
  try {
    await f.capture(); const viewer = await f.member("viewer");
    const foreign = (await f.call("POST", "/api/team/projects", { name: "Other scope" }, f.owner)).json;
    expect((await f.call("GET", `/api/team/projects/${foreign.id}/evidence/capabilities`, undefined, viewer)).status).toBe(404);
    expect((await f.call("POST", f.base + "/imports", f.frame("viewer-denied"), viewer, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE })).status).toBe(403);
    expect((await f.call("POST", f.base + "/imports", f.frame("csrf-denied"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE, "X-RunPhantom-CSRF": "wrong" })).status).toBe(403);
    expect((await f.call("POST", f.base + "/imports", f.frame("origin-denied"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE, Origin: "http://foreign.invalid" })).status).toBe(403);
    expect((await f.call("POST", f.base + "/imports", f.frame("encoding-denied"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE, "Content-Encoding": "gzip" })).status).toBe(415);
    for (const query of ["unexpected=1", "operationKey=a&operationKey=b"]) expect((await f.call("GET", f.base + "/imports?" + query, undefined, f.owner)).status).toBe(400);
    for (const value of ['{"kind":"run","kind":"inspection","id":"' + runId + '"}', '{"broken":', '{"x":' + "[".repeat(5) + "0" + "]".repeat(5) + "}"]) {
      expect((await f.call("GET", f.base + "/sets?" + new URLSearchParams({ attachment: value }).toString(), undefined, f.owner)).status).toBe(400);
    }
    expect((await f.call("GET", f.base + "/imports/foreign-job", undefined, f.owner)).status).toBe(404);
    for (const anchor of [{ kind: "experiment", id: "invented" }, { kind: "run", id: "absent" }]) {
      const upload = await f.call("POST", f.base + "/imports", f.frame("unsupported-" + anchor.kind, { attachment: anchor }), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
      expect(upload.status).toBe(anchor.kind === "experiment" ? 400 : 404);
    }
    const dataset = new URLSearchParams({ anchor: JSON.stringify({ kind: "dataset_revision", id: "invented", version: 1 }) });
    expect((await f.call("GET", f.base + "/inventories?" + dataset.toString(), undefined, f.owner)).status).toBe(400);
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs")).toEqual({ n: 0 });
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_blobs")).toEqual({ n: 0 });
  } finally { await f.close(); }
});

test("Team evidence reparse and retention report current availability without changing captured output", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const upload = await f.call("POST", f.base + "/imports", f.frame("retention-original"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
    expect(upload.status).toBe(202); const original = await f.completed(upload.json.job.id); expect(original.json.job.status).toBe("completed");
    const id = original.json.job.setId;
    const exported = await f.call("GET", `${f.base}/sets/${id}/export?revision=1&format=json`, undefined, f.owner);
    expect(exported.status).toBe(200); expect(exported.json.sources[0].observation).toMatchObject({ reportOutcome: "reports_pass", leaves: [{ id: "leaf-0", status: "passed", durationMs: 0 }] }); expect(exported.text).not.toContain("Actual Team report"); expect(exported.text).not.toContain('"raw"');
    const reparse = await f.call("POST", `${f.base}/sets/${id}/reparse`, { expectedRevision: 1, operationKey: "retention-reparse" }, f.owner);
    expect(reparse.status).toBe(202); const done = await f.completed(reparse.json.job.id); expect(done.json.job.status).toBe("completed"); expect(done.json.job.setId).toBe(id);
    const view = await f.call("GET", `${f.base}/sets/${id}?revision=2`, undefined, f.owner); expect(view.status).toBe(200); expect(view.json.sources[0].rawAvailable).toBe(true);
    expect((await f.call("DELETE", `${f.base}/sets/${id}/retention/raw?revision=2`, undefined, f.owner)).json.removed).toBe(1);
    expect((await f.call("GET", `${f.base}/sets/${id}/raw/report-1?revision=2`, undefined, f.owner)).status).toBe(404);
    expect((await f.call("GET", `${f.base}/sets/${id}?revision=2`, undefined, f.owner)).json.sources[0]).toMatchObject({ rawAvailable: false, normalizedAvailable: true });
    expect((await f.call("DELETE", `${f.base}/sets/${id}/retention/normalized?revision=2`, undefined, f.owner)).json.removed).toBe(1);
    expect((await f.call("GET", `${f.base}/sets/${id}?revision=2`, undefined, f.owner)).json.sources[0]).toMatchObject({ rawAvailable: false, normalizedAvailable: false, normalized: null });
    expect((await f.call("POST", `${f.base}/sets/${id}/reparse`, { expectedRevision: 2, operationKey: "removed-reparse" }, f.owner)).status).toBe(404);
    expect((await f.call("GET", `/api/team/projects/${f.project.id}/runs/${runId}/spans/${spanId}`, undefined, f.owner)).json.outputPayload).toBe("Exact captured output");
  } finally { await f.close(); }
});

test("actual admin clear reaps a revoked editor held frame and preserves another project's generation", async () => {
  const f = await fixture(); let upload: ReturnType<typeof httpRequest> | undefined;
  try {
    await f.capture(); const editor = await f.member("editor");
    const other = (await f.call("POST", "/api/team/projects", { name: "Preserved other scope" }, f.owner)).json;
    const frame = f.frame("revoked-http-held");
    const response = new Promise<number>((resolve, reject) => {
      upload = httpRequest(f.url + f.base + "/imports", { method: "POST", headers: { Host: new URL(f.config.publicOrigin).host, Origin: f.config.publicOrigin, Cookie: editor.cookie, "X-RunPhantom-CSRF": editor.csrf, "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE, "Content-Length": frame.byteLength } }, result => { result.resume(); resolve(result.statusCode!); });
      upload.on("error", reject); upload.write(frame.subarray(0, frame.byteLength - sourceBytes.byteLength));
    });
    // Attach a handler immediately so refusal during clear is never unhandled.
    const result = response.then(status => status, () => 0);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !f.sql("SELECT id FROM evaluation_evidence_jobs WHERE operation_key='revoked-http-held'")) await Bun.sleep(5);
    expect(f.sql("SELECT status FROM evaluation_evidence_jobs WHERE operation_key='revoked-http-held'")).toEqual({ status: "running" });
    expect((await f.call("DELETE", `/api/team/projects/${f.project.id}/members/${editor.userId}`, undefined, f.owner)).status).toBe(204);
    expect((await f.call("DELETE", f.base + "/all", undefined, f.owner)).status).toBe(200);
    expect([0, 404, 409]).toContain(await result);
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE scope_key=?", "project:" + f.project.id)).toEqual({ n: 0 });
    expect(f.sql("SELECT generation FROM evaluation_evidence_scopes WHERE scope_key=?", "project:" + f.project.id)).toEqual({ generation: 2 });
    expect(f.sql("SELECT generation FROM evaluation_evidence_scopes WHERE scope_key=?", "project:" + other.id)).toEqual({ generation: 1 });
    expect((await f.call("GET", `/api/team/projects/${other.id}/evidence/capabilities`, undefined, f.owner)).status).toBe(200);
    expect((await f.call("GET", `/api/team/projects/${f.project.id}/runs/${runId}/spans/${spanId}`, undefined, f.owner)).json.outputPayload).toBe("Exact captured output");
  } finally { upload?.destroy(); await f.close(); }
});

test("held Team source bytes cannot publish after current membership or session revocation", async () => {
  const f = await fixture();
  try {
    await f.capture(); const editor = await f.member("editor");
    for (const boundary of ["membership", "session"] as const) {
      const held = f.held("revoke-" + boundary, editor);
      try {
        await f.admitted("revoke-" + boundary);
        if (boundary === "membership") expect((await f.call("PATCH", `/api/team/projects/${f.project.id}/members/${editor.userId}`, { role: "viewer" }, f.owner)).status).toBe(200);
        else expect((await f.call("POST", "/api/team/logout", {}, editor)).status).toBe(204);
        held.finish(); expect(await held.result).toBe(boundary === "membership" ? 403 : 401);
        expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_sets")).toEqual({ n: 0 });
        expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_blobs")).toEqual({ n: 0 });
        if (boundary === "membership") expect((await f.call("PATCH", `/api/team/projects/${f.project.id}/members/${editor.userId}`, { role: "editor" }, f.owner)).status).toBe(200);
      } finally { held.upload.destroy(); }
    }
    expect((await f.call("DELETE", f.base + "/all", undefined, f.owner)).status).toBe(200);
  } finally { await f.close(); }
});

test("awaited strict control body rechecks the original session before inventory admission", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const bytes = Buffer.from(JSON.stringify({ anchor: { kind: "run", id: runId }, expectedRevision: 0, expected: [{ shardId: "unit", kind: "junit" }] }));
    // PUT is deliberately held before its last byte, after authentication at the route boundary.
    const held = f.held("control", f.owner, f.base + "/inventories", bytes, bytes.byteLength - 1, "application/json");
    try {
      await Bun.sleep(20);
      expect((await f.call("POST", "/api/team/logout", {}, f.owner)).status).toBe(204);
      held.finish(); expect(await held.result).toBe(401);
      expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_inventories")).toEqual({ n: 0 });
    } finally { held.upload.destroy(); }
  } finally { await f.close(); }
});

test("Team coordinator shares two active and eight queued held imports across projects", async () => {
  const f = await fixture(); const held: ReturnType<typeof f.held>[] = [];
  try {
    await f.capture();
    const other = (await f.call("POST", "/api/team/projects", { name: "Shared coordinator" }, f.owner)).json;
    // Existing capture IDs can coexist in a second project; only the explicit route owns its evidence scope.
    const key = (await f.call("POST", `/api/team/projects/${other.id}/keys`, { label: "Other exporter" }, f.owner)).json;
    const traces = { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: runId, spanId, name: "Other run", startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000001000000000" }] }] }] };
    expect((await f.call("POST", "/api/team/ingest/v1/traces", traces, undefined, { Authorization: `Bearer ${key.token}` })).status).toBe(200);
    for (let index = 0; index < 10; index++) {
      held.push(f.held("shared-" + index, f.owner, index % 2 ? `/api/team/projects/${other.id}/evidence/imports` : f.base + "/imports"));
      await f.admitted("shared-" + index);
    }
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE status='running'")).toEqual({ n: 2 });
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE status='queued'")).toEqual({ n: 8 });
    expect((await f.call("POST", f.base + "/imports", f.frame("shared-overflow"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE })).status).toBe(409);
    const first = await f.admitted("shared-0");
    expect((await f.call("POST", `${f.base}/imports/${first.id}/cancel`, {}, f.owner)).json.cancelled).toBe(true);
    expect(await held[0].result).toBe(409);
    expect(f.sql("SELECT status,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE id=?", first.id)).toEqual({ status: "cancelled", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
    expect((await f.call("DELETE", f.base + "/all", undefined, f.owner)).status).toBe(200);
    expect((await f.call("DELETE", `/api/team/projects/${other.id}/evidence/all`, undefined, f.owner)).status).toBe(200);
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs")).toEqual({ n: 0 });
  } finally { for (const item of held) item.upload.destroy(); await f.close(); }
});

test("native Team shutdown terminalizes held jobs and restart preserves normalized DTOs", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const receipt = await f.call("POST", f.base + "/imports", f.frame("restart-completed"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
    const done = await f.completed(receipt.json.job.id);
    const before = await f.call("GET", `${f.base}/sets/${done.json.job.setId}?revision=1`, undefined, f.owner);
    const held = f.held("restart-held");
    try {
      const row = await f.admitted("restart-held");
      const token = f.sql("SELECT job_token FROM evaluation_evidence_jobs WHERE id=?", row.id);
      await f.restart(); await held.result;
      expect(f.sql("SELECT status,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE id=?", row.id)).toEqual({ status: "failed", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
      expect(f.sql("SELECT job_token FROM evaluation_evidence_jobs WHERE id=?", row.id)).not.toEqual(token);
      expect((await f.call("GET", `${f.base}/sets/${done.json.job.setId}?revision=1`, undefined, f.owner)).json).toEqual(before.json);
      expect((await f.call("GET", `${f.base}/imports/${done.json.job.id}`, undefined, f.owner)).json.timings.availability).toBe("unavailable");
      // A persisted interrupted job is a startup fixture, with the same digest checked original admission.
      await f.handle.close();
      f.mutate("UPDATE evaluation_evidence_jobs SET status='queued',reserved_raw_bytes=1,reserved_normalized_bytes=1 WHERE id=?", row.id);
      await f.restart();
      expect(f.sql("SELECT status,failure_code,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE id=?", row.id)).toEqual({ status: "failed", failure_code: "restart_interrupted", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
    } finally { held.upload.destroy(); }
  } finally { await f.close(); }
});

test("admin run deletion reaps active attachments transactionally while frozen checks survive", async () => {
  const f = await fixture();
  try {
    await f.capture(); const candidateId = "3".repeat(32); await f.capture(candidateId);
    const check = await f.call("POST", `/api/team/projects/${f.project.id}/checks`, { name: "Preserved check", referenceRunId: runId, candidateRunIds: [candidateId], rules: [{ kind: "output", operation: "equals", value: "Exact captured output" }] }, f.owner);
    expect(check.status).toBe(201);
    const frozen = f.sql("SELECT data,report,byte_size FROM checks WHERE project_id=? AND id=?", f.project.id, check.json.id);
    const editor = await f.member("editor"), held = f.held("delete-active", editor);
    try {
      await f.admitted("delete-active");
      const context = f.handle.store.projectScope(f.handle.store.getSession((f.sql("SELECT token_hash FROM sessions WHERE account_id=?", f.owner.userId) as { token_hash: string }).token_hash)!, f.project.id);
      expect(() => f.handle.store.deleteRun(context, runId)).toThrow("active external report import");
      expect((await f.call("DELETE", `/api/team/projects/${f.project.id}/members/${editor.userId}`, undefined, f.owner)).status).toBe(204);
      expect((await f.call("DELETE", `/api/team/projects/${f.project.id}/runs/${runId}`, undefined, f.owner)).status).toBe(204);
      expect([0, 404, 409]).toContain(await held.result);
      expect((await f.call("GET", `/api/team/projects/${f.project.id}/runs/${runId}`, undefined, f.owner)).status).toBe(404);
      expect(f.sql("SELECT data,report,byte_size FROM checks WHERE project_id=? AND id=?", f.project.id, check.json.id)).toEqual(frozen);
      const upload = await f.call("POST", f.base + "/imports", f.frame("frozen-check", { attachment: { kind: "check", id: check.json.id } }), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
      expect(upload.status).toBe(202); expect((await f.completed(upload.json.job.id)).json.job.status).toBe("completed");
      expect((await f.call("DELETE", f.base + "/all", undefined, f.owner)).status).toBe(200);
      expect(f.sql("SELECT data,report,byte_size FROM checks WHERE project_id=? AND id=?", f.project.id, check.json.id)).toEqual(frozen);
    } finally { held.upload.destroy(); }
  } finally { await f.close(); }
});

test("actual32-source near4MiB publication expands to a bounded transport DTO and minimized exports", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const descriptors = (bytes: Uint8Array[]) => bytes.map((value, index) => ({ sourceId: "report-" + String(index).padStart(2, "0"), shardId: "unit-" + index, kind: "junit", dialect: "junit-xml/v1", artifactSha256: evidenceDigest(value), byteLength: value.byteLength }));
    const upload = async (key: string, bytes: Uint8Array[]) => {
      const response = await f.call("POST", f.base + "/imports", f.frame(key, { sources: descriptors(bytes), retention: "normalized_only" }, bytes), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
      expect(response.status).toBe(202); const done = await f.completed(response.json.job.id); expect(done.json.job.status).toBe("completed");
      return done.json.job.setId as string;
    };
    const baseline = await upload("population-metadata", Array.from({ length: 32 }, () => sourceBytes));
    const metadata = f.sql("SELECT length(cast(data AS BLOB)) AS bytes FROM evaluation_evidence_sets WHERE id=?", baseline) as { bytes: number };
    const target = 4 * 1024 * 1024 - metadata.bytes - 1200;
    const count = 600;
    const names = Array.from({ length: 32 }, () => Array.from({ length: count }, () => ""));
    const make = (index: number) => Buffer.from('<testsuite tests="600">' + names[index].map(name => `<testcase name="${name}" time="0"/>`).join("") + "</testsuite>");
    const measured = (index: number) => Buffer.byteLength(canonicalEvidenceJson(parseExternalEvidence(make(index), "junit-xml/v1", "report-" + String(index).padStart(2, "0"))));
    const emptyBytes = names.reduce((sum, _value, index) => sum + measured(index), 0);
    let remaining = target - emptyBytes;
    expect(remaining).toBeGreaterThan(0);
    for (const group of names) for (let index = 0; index < group.length && remaining > 0; index++) {
      const length = Math.min(512, remaining); group[index] = "x".repeat(length); remaining -= length;
    }
    expect(remaining).toBe(0);
    const bytes = names.map((_value, index) => make(index));
    expect(bytes.reduce((sum, value) => sum + value.byteLength, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    const id = await upload("population-maximal", bytes);
    const held = f.sql("SELECT (SELECT sum(length(cast(data AS BLOB))) FROM evaluation_evidence_payloads WHERE scope_key=s.scope_key AND interpretation_id IN (SELECT json_extract(value,'$.interpretationId') FROM json_each(s.data,'$.sources'))) + length(cast(s.data AS BLOB)) AS bytes FROM evaluation_evidence_sets s WHERE id=?", id) as { bytes: number };
    expect(held.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(held.bytes).toBeGreaterThan(4 * 1024 * 1024 - 4096);
    const view = await f.call("GET", `${f.base}/sets/${id}?revision=1`, undefined, f.owner);
    expect(view.status).toBe(200); expect(view.json.sources).toHaveLength(32);
    expect(Buffer.byteLength(view.text)).toBeGreaterThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(view.text)).toBeLessThanOrEqual(8 * 1024 * 1024);
    for (const format of ["json", "text", "junit"]) {
      const response = await f.call("GET", `${f.base}/sets/${id}/export?revision=1&format=${format}`, undefined, f.owner);
      expect(response.status).toBe(200); expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    for (let index = 0; index < 6; index++) await upload("population-quota-" + index, bytes);
    const ledger = f.sql("SELECT (SELECT sum(length(cast(data AS BLOB))) FROM evaluation_evidence_payloads) + (SELECT sum(length(cast(data AS BLOB))) FROM evaluation_evidence_sets) AS bytes") as { bytes: number };
    expect(ledger.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(ledger.bytes + 4 * 1024 * 1024).toBeGreaterThan(32 * 1024 * 1024);
    expect((await f.call("POST", f.base + "/imports", f.frame("normalized-quota-overflow"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE })).status).toBe(409);
    expect(f.sql("SELECT coalesce(sum(reserved_raw_bytes),0) AS raw,coalesce(sum(reserved_normalized_bytes),0) AS normalized FROM evaluation_evidence_jobs")).toEqual({ raw: 0, normalized: 0 });
    console.info(JSON.stringify({ proof: "team-evidence-max-population", sources: 32, leaves: count * 32, selectedStoredBytes: held.bytes, detailDtoBytes: Buffer.byteLength(view.text), projectNormalizedBytes: ledger.bytes, normalizedQuotaBytes: 32 * 1024 * 1024 }));
  } finally { await f.close(); }
}, 20_000);

test("actual retained raw2MiB sources fill separate64MiB project quota without capture counter changes", async () => {
  const f = await fixture();
  try {
    await f.capture(); const before = f.sql("SELECT evidence_bytes,run_count,span_count,check_count FROM projects WHERE id=?", f.project.id);
    const prefix = '<testsuite tests="1"><testcase name="Bounded quota"/><!--', suffix = '--></testsuite>';
    const raw = Buffer.from(prefix + "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(prefix + suffix)) + suffix);
    const sources = Array.from({ length: 4 }, (_, index) => ({ sourceId: "raw-" + index, shardId: "unit-" + index, kind: "junit", dialect: "junit-xml/v1", artifactSha256: evidenceDigest(raw), byteLength: raw.byteLength }));
    let firstId = "";
    for (let index = 0; index < 8; index++) {
      const response = await f.call("POST", f.base + "/imports", f.frame("raw-quota-" + index, { sources }, [raw, raw, raw, raw]), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
      expect(response.status).toBe(202); const done = await f.completed(response.json.job.id); expect(done.json.job.status).toBe("completed");
      if (!index) firstId = done.json.job.setId;
    }
    expect(f.sql("SELECT sum(length(bytes)) AS bytes FROM evaluation_evidence_blobs")).toEqual({ bytes: 64 * 1024 * 1024 });
    expect((await f.call("POST", f.base + "/imports", f.frame("raw-quota-overflow"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE })).status).toBe(409);
    const exported = await f.call("GET", `${f.base}/sets/${firstId}/raw/raw-0?revision=1`, undefined, f.owner);
    expect(exported.status).toBe(200); expect(Buffer.byteLength(exported.text)).toBe(2 * 1024 * 1024); expect(evidenceDigest(exported.text)).toBe(evidenceDigest(raw));
    const excess = Buffer.concat([raw, Buffer.from(" ")]);
    expect((await f.call("POST", f.base + "/imports", f.frame("raw-byte-excess", { sources: [{ ...sources[0], byteLength: excess.byteLength, artifactSha256: evidenceDigest(excess) }] }, [excess]), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE })).status).toBe(400);
    expect(f.sql("SELECT evidence_bytes,run_count,span_count,check_count FROM projects WHERE id=?", f.project.id)).toEqual(before);
    console.info(JSON.stringify({ proof: "team-evidence-raw-quota", actualImportJobs: 8, importedSources: 32, retainedRawBytes: 64 * 1024 * 1024, rawExportBytes: Buffer.byteLength(exported.text), overflowStatus: 409, captureCountersUnchanged: true }));
    expect((await f.call("DELETE", `${f.base}/sets/${firstId}/retention/raw?revision=1`, undefined, f.owner)).json.removed).toBe(4);
    expect((await f.call("POST", f.base + "/imports", f.frame("raw-after-retention"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE })).status).toBe(202);
  } finally { await f.close(); }
}, 20_000);

test("legitimate XML source identity expansion accepts exact8MiB and refuses plus1 before serialization", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const sourceId = '"'.repeat(30) + "x".repeat(98);
    const make = (times: string[]) => Buffer.from(`<testsuite tests="${times.length}">` + times.map(time => `<testcase name="" time="${time}"/>`).join("") + "</testsuite>");
    const upload = async (key: string, bytes: Uint8Array) => {
      const response = await f.call("POST", f.base + "/imports", f.frame(key, { retention: "normalized_only", sources: [{ sourceId, shardId: "unit", kind: "junit", dialect: "junit-xml/v1", byteLength: bytes.byteLength, artifactSha256: evidenceDigest(bytes) }] }, [bytes]), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
      expect(response.status).toBe(202); const done = await f.completed(response.json.job.id); expect(done.json.job.status).toBe("completed"); return done.json.job.setId as string;
    };
    const pilotId = await upload("expansion-pilot", make(["0"]));
    const pilot = (await f.call("GET", `${f.base}/sets/${pilotId}?revision=1`, undefined, f.owner)).json;
    // This is a sizing calculation from actual admitted metadata, never a fabricated stored publication.
    const size = (times: string[]) => Buffer.byteLength(evidenceExportJUnit({ ...pilot, sources: [{ ...pilot.sources[0], normalized: parseExternalEvidence(make(times), "junit-xml/v1", sourceId) }] }));
    const times = Array.from({ length: 20_000 }, () => "0");
    const original = size(times), delta = size([...times, "0"]) - original;
    const limit = 8 * 1024 * 1024;
    times.push(...Array.from({ length: Math.floor((limit - original) / delta) }, () => "0"));
    let remaining = limit - size(times);
    for (let index = 0; remaining > 0; index++) {
      const extra = Math.min(12, remaining); times[index] = "1".repeat(extra + 1); remaining -= extra;
    }
    expect(size(times)).toBe(limit);
    const exact = await upload("expansion-exact", make(times));
    const response = await f.call("GET", `${f.base}/sets/${exact}/export?revision=1&format=junit`, undefined, f.owner);
    expect(response.status).toBe(200); expect(Buffer.byteLength(response.text)).toBe(limit);
    times[times.length - 1] = "10";
    expect(size(times)).toBe(limit + 1);
    const excess = await upload("expansion-excess", make(times));
    const refused = await f.call("GET", `${f.base}/sets/${excess}/export?revision=1&format=junit`, undefined, f.owner);
    expect(refused.status).toBe(413); expect(refused.json.error.code).toBe("too_large");
    expect((await f.call("GET", `${f.base}/sets/${excess}?revision=1`, undefined, f.owner)).status).toBe(200);
    expect((await f.call("GET", `${f.base}/sets/${excess}/export?revision=1&format=json`, undefined, f.owner)).status).toBe(200);
    console.info(JSON.stringify({ proof: "team-evidence-expanded-junit", classifiedLeaves: times.length, exactBytes: limit, exactStatus: response.status, plusOneBytes: size(times), plusOneStatus: refused.status }));
  } finally { await f.close(); }
}, 20_000);

test("actual lost202 receipt is recovered by operation identity without a second publication", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const lost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(f.url + f.base + "/imports", { method: "POST", headers: { Host: new URL(f.config.publicOrigin).host, Origin: f.config.publicOrigin, Cookie: f.owner.cookie, "X-RunPhantom-CSRF": f.owner.csrf, "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } }, response => {
        // Discard the receipt body on the actual client connection.
        resolve(response.statusCode!); response.destroy(); request.destroy();
      });
      request.on("error", reject); request.end(f.frame("lost-receipt"));
    });
    expect(lost).toBe(202);
    const recovered = await f.call("GET", f.base + "/imports?operationKey=lost-receipt", undefined, f.owner);
    expect(recovered.status).toBe(200);
    const retry = await f.call("POST", f.base + "/imports", f.frame("lost-receipt"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
    expect(retry.status).toBe(202); expect(retry.json.reused).toBe(true); expect(retry.json.job.id).toBe(recovered.json.job.id);
    expect((await f.completed(recovered.json.job.id)).json.job.status).toBe("completed");
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE operation_key='lost-receipt'")).toEqual({ n: 1 });
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_sets")).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("clear and run deletion preserve active admission integrity errors instead of purging corruption", async () => {
  const f = await fixture(); const held: ReturnType<typeof f.held>[] = [];
  try {
    await f.capture();
    for (const boundary of ["clear", "delete"] as const) {
      held.push(f.held("integrity-" + boundary));
      const row = await f.admitted("integrity-" + boundary);
      f.mutate("UPDATE evaluation_evidence_jobs SET request_data=? WHERE id=?", "x".repeat(65537), row.id);
      const response = await f.call("DELETE", boundary === "clear" ? f.base + "/all" : `/api/team/projects/${f.project.id}/runs/${runId}`, undefined, f.owner);
      expect(response.status).toBe(409);
      expect(f.sql("SELECT generation FROM evaluation_evidence_scopes WHERE scope_key=?", "project:" + f.project.id)).toEqual({ generation: 1 });
      expect(f.sql("SELECT count(*) AS n FROM runs WHERE project_id=? AND id=?", f.project.id, runId)).toEqual({ n: 1 });
      expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE id=?", row.id)).toEqual({ n: 1 });
    }
  } finally { for (const item of held) item.upload.destroy(); await f.close(); }
});

test.skipIf(process.platform === "win32")("native Team shutdown reaps a live isolated reader child before closing SQLite", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const raw = Buffer.from('<testsuite tests="400">' + `<testcase name="${"x".repeat(512)}"/>`.repeat(400) + "</testsuite>");
    const sources = Array.from({ length: 32 }, (_, index) => ({ sourceId: "source-" + index, shardId: "unit-" + index, kind: "junit", dialect: "junit-xml/v1", byteLength: raw.byteLength, artifactSha256: evidenceDigest(raw) }));
    const response = await f.call("POST", f.base + "/imports", f.frame("shutdown-live-child", { sources, retention: "normalized_only" }, sources.map(() => raw)), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
    expect(response.status).toBe(202);
    const children = async () => {
      const processList = Bun.spawn(["ps", "-ax", "-o", "pid=,ppid=,args="], { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(processList.stdout).text(); await processList.exited;
      return output.split("\n").filter(line => line.includes("/evaluations/evidence-worker.ts") && Number(line.trim().split(/\s+/)[1]) === process.pid).map(line => Number(line.trim().split(/\s+/)[0]));
    };
    let pids: number[] = []; const deadline = Date.now() + 1000;
    while (!pids.length && Date.now() < deadline) { pids = await children(); if (!pids.length) await Bun.sleep(5); }
    expect(pids.length).toBeGreaterThan(0);
    await f.handle.close();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(await children()).toEqual([]);
    console.info(JSON.stringify({ proof: "team-evidence-native-worker-shutdown", platform: process.platform, observedWorkerPids: pids, everyObservedWorkerReaped: true, remainingOwnedWorkers: 0 }));
    expect(f.sql("SELECT status,failure_code,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE id=?", response.json.job.id)).toEqual({ status: "failed", failure_code: "shutdown", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
    await f.restart();
    expect((await f.call("GET", `${f.base}/imports/${response.json.job.id}`, undefined, f.owner)).json.job.failureCode).toBe("shutdown");
  } finally { await f.close(); }
});

test("digest checked retained-history fixture admits job1000 and refuses job1001 through actual HTTP", async () => {
  const f = await fixture();
  try {
    await f.capture();
    const first = await f.call("POST", f.base + "/imports", f.frame("history-original"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
    expect((await f.completed(first.json.job.id)).json.job.status).toBe("completed");
    // Bounded persisted history fixture: all metadata derives from a real current-authority admission.
    const db = new Database(path.join(f.directory, "team.sqlite"));
    try {
      const row = db.query("SELECT request_data,admitted_at,deadline_at FROM evaluation_evidence_jobs WHERE id=?").get(first.json.job.id) as { request_data: string; admitted_at: number; deadline_at: number };
      const statement = db.query("INSERT INTO evaluation_evidence_jobs(id,scope_key,scope_generation,operation_key,request_digest,request_data,inventory_data,status,job_token,admitted_at,deadline_at,set_id,failure_code,reserved_raw_bytes,reserved_normalized_bytes) VALUES(?,?,1,?,?,?,NULL,'failed',?,?,?,NULL,'source_integrity',0,0)");
      db.transaction(() => {
        for (let index = 0; index < 998; index++) {
          const request = { ...JSON.parse(row.request_data), operationKey: "retained-" + index };
          statement.run("retained-" + index, "project:" + f.project.id, request.operationKey, evidenceDigest(canonicalEvidenceJson({ scope: { kind: "project", id: f.project.id }, generation: 1, request, inventoryDigest: null })), canonicalEvidenceJson(request), "retained-token-" + index, row.admitted_at, row.deadline_at);
        }
      }).immediate();
    } finally { db.close(); }
    expect((await f.call("GET", f.base + "/imports/retained-997", undefined, f.owner)).json.job.status).toBe("failed");
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs")).toEqual({ n: 999 });
    const thousand = await f.call("POST", f.base + "/imports", f.frame("history-thousand"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE });
    expect(thousand.status).toBe(202); expect((await f.completed(thousand.json.job.id)).json.job.status).toBe("completed");
    expect(f.sql("SELECT count(*) AS n FROM evaluation_evidence_jobs")).toEqual({ n: 1000 });
    expect((await f.call("POST", f.base + "/imports", f.frame("history-overflow"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE })).status).toBe(409);
    expect((await f.call("DELETE", f.base + "/all", undefined, f.owner)).status).toBe(200);
    expect((await f.call("POST", f.base + "/imports", f.frame("history-after-clear"), f.owner, { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE })).status).toBe(202);
  } finally { await f.close(); }
});
