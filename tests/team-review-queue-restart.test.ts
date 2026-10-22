import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { TeamReviewItem, TeamReviewReceipt } from "../src/team/review-queue-protocol";

test("two genuine Team daemon processes race receipts and survive killed ACK restart on one unchanged database", async () => {
  const profile = mkdtempSync(path.join(realpathSync(tmpdir()), "f30-team-process-")), dataDir = path.join(profile, "team"), bootstrap = randomBytes(32).toString("base64url");
  const processes: Array<{ child: ChildProcess; url: string; birth: string }> = [];
  async function boot() {
    const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve)); const address = socket.address(); if (!address || typeof address === "string") throw new Error("No private port"); await new Promise<void>(resolve => socket.close(() => resolve())); const url = `http://127.0.0.1:${address.port}`;
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)));
    const child = spawn(process.execPath, [path.resolve(import.meta.dir, "../src/index.ts"), "team", "serve"], { cwd: profile, env: { ...inherited, RUNPHANTOM_TEAM_DATA_DIR: dataDir, RUNPHANTOM_TEAM_PORT: String(address.port), RUNPHANTOM_TEAM_BIND_HOST: "127.0.0.1", RUNPHANTOM_TEAM_PUBLIC_ORIGIN: url, RUNPHANTOM_TEAM_BOOTSTRAP_CODE: bootstrap }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", launchError: Error | null = null; child.on("error", cause => { launchError = cause; }); child.stdout?.on("data", bytes => { output = (output + bytes.toString()).slice(-8192); }); child.stderr?.on("data", bytes => { output = (output + bytes.toString()).slice(-8192); });
    const row = { child, url, birth: child.pid ? execFileSync("ps", ["-p", String(child.pid), "-o", "lstart="], { encoding: "utf8" }).trim() : "unavailable" }; processes.push(row);
    for (let attempt = 0; attempt < 400; attempt++) { if (launchError || child.exitCode !== null) throw new Error(`Owned native daemon failed: ${output}`); try { if ((await fetch(url + "/api/team/session", { signal: AbortSignal.timeout(500) })).status === 200) return row; } catch { /* bounded readiness */ } await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error("Owned native daemon startup failed");
  }
  async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill("SIGKILL"), 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill(signal); });
  }
  let cookie = "", csrf = "";
  async function call(url: string, method: string, endpoint: string, body?: unknown) {
    const response = await fetch(url + "/api/team" + endpoint, { method, headers: { Origin: url, ...(cookie ? { Cookie: cookie, "X-RunPhantom-CSRF": csrf } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: response.status === 204 ? null : await response.json() };
  }
  const counts = () => { const db = new Database(path.join(dataDir, "team.sqlite"), { readonly: true }); try { return { version: db.query("PRAGMA user_version").get(), revisions: db.query("SELECT count(*) AS n FROM team_review_dataset_revisions").get(), receipts: db.query("SELECT count(*) AS n FROM team_review_promotions").get(), states: db.query("SELECT state,count(*) AS n FROM team_review_items GROUP BY state ORDER BY state").all() }; } finally { db.close(); } };
  let report: Record<string, unknown> | null = null;
  const reaping: Array<{ pid: number | undefined; exitCode: number | null; signalCode: NodeJS.Signals | null; listenerRefused: boolean }> = [];
  try {
    const first = await boot(), setup = await call(first.url, "POST", "/setup", { setupCode: bootstrap, email: "owner@example.test", password: "native restart password" }); expect(setup.response.status).toBe(201); cookie = setup.response.headers.get("set-cookie")!.split(";")[0]; csrf = setup.data.csrfToken;
    const project = await call(first.url, "POST", "/projects", { name: "Native concurrent review" }); expect(project.response.status).toBe(201); const prefix = `/projects/${project.data.id}`;
    const key = await call(first.url, "POST", prefix + "/keys", { label: "Native source" }); expect(key.response.status).toBe(201);
    const runId = "1".repeat(32), spanId = "2".repeat(16);
    async function capture(output: string, id = runId) { const response = await fetch(first.url + "/api/team/ingest/v1/traces", { method: "POST", headers: { Origin: first.url, Authorization: `Bearer ${key.data.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: id, spanId, name: "Native β", startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000001000000000", status: { code: 1 }, attributes: [{ key: "openinference.span.kind", value: { stringValue: "AGENT" } }, { key: "runphantom.input", value: { stringValue: "Input β" } }, { key: "runphantom.output", value: { stringValue: output } }] }] }] }] }) }); expect(response.status).toBe(200); }
    await capture("Frozen β"); const queue = await call(first.url, "POST", prefix + "/review-queues", { name: "Native frozen queue" }); expect(queue.response.status).toBe(201); const at = prefix + `/review-queues/${queue.data.id}`;
    const intake = await call(first.url, "POST", at + "/items", { runId }); expect(intake.response.status).toBe(201); const item: TeamReviewItem = intake.data;
    const second = await boot(); expect(second.child.pid).not.toBe(first.child.pid); expect(first.birth).not.toBe("unavailable"); expect(second.birth).not.toBe("unavailable");
    const race = await Promise.all([first, second].map((daemon, index) => call(daemon.url, "PUT", at + `/items/${item.id}`, { expectedRevision: item.revision, mutationId: randomUUID(), draft: { ...item.draft, name: `Curator ${index}`, target: { expectedOutput: "Curated β" } } }))); expect(race.map(row => row.response.status).sort()).toEqual([200, 409]);
    const winner: TeamReviewItem = race.find(row => row.response.status === 200)!.data, approved = await call(first.url, "POST", at + `/items/${item.id}/approve`, { expectedRevision: winner.revision, mutationId: randomUUID(), draft: winner.draft }); expect(approved.response.status).toBe(200);
    const dataset = await call(first.url, "POST", prefix + "/review-datasets", { name: "Native curated" }); expect(dataset.response.status).toBe(201);
    const request = { datasetId: dataset.data.datasetId, expectedDatasetVersion: 1, idempotencyKey: randomUUID(), items: [{ itemId: item.id, expectedRevision: approved.data.revision }] };
    const filename = path.join(dataDir, "team.sqlite"), before = statSync(filename);
    const promoted = await Promise.all([first, second].map(daemon => call(daemon.url, "POST", at + "/promotions", request))); expect(promoted.map(row => row.response.status)).toEqual([201, 201]); expect(promoted[0].data).toEqual(promoted[1].data); const receipt: TeamReviewReceipt = promoted[0].data;
    expect(counts()).toEqual({ version: { user_version: 5 }, revisions: { n: 2 }, receipts: { n: 1 }, states: [{ state: "promoted", n: 1 }] });
    // Cancel the first response for a distinct new promotion without parsing its receipt, then hard-kill that native process.
    const crashRun = "3".repeat(32); await capture("Frozen δ", crashRun);
    const crashItem = await call(first.url, "POST", at + "/items", { runId: crashRun }); expect(crashItem.response.status).toBe(201);
    const crashApproved = await call(first.url, "POST", at + `/items/${crashItem.data.id}/approve`, { expectedRevision: crashItem.data.revision, mutationId: randomUUID(), draft: { ...crashItem.data.draft, target: { expectedOutput: "Curated δ" } } }); expect(crashApproved.response.status).toBe(200);
    const crashRequest = { ...request, expectedDatasetVersion: 2, idempotencyKey: randomUUID(), items: [{ itemId: crashItem.data.id, expectedRevision: crashApproved.data.revision }] };
    const lost = await fetch(second.url + "/api/team" + at + "/promotions", { method: "POST", headers: { Origin: second.url, Cookie: cookie, "X-RunPhantom-CSRF": csrf, "Content-Type": "application/json" }, body: JSON.stringify(crashRequest) }); expect(lost.status).toBe(201); await lost.body?.cancel(); await stop(second.child, "SIGKILL"); expect(second.child.signalCode).toBe("SIGKILL");
    const crashReceipt = await call(first.url, "GET", at + `/promotions/${crashRequest.idempotencyKey}`); expect(crashReceipt.response.status).toBe(200);
    await capture("Live γ"); const restarted = await boot(); expect(restarted.child.pid).not.toBe(second.child.pid); expect(statSync(filename).ino).toBe(before.ino); expect(statSync(filename).dev).toBe(before.dev);
    const retry = await call(restarted.url, "POST", at + "/promotions", request); expect(retry.response.status).toBe(201); expect(retry.data).toEqual(receipt);
    const crashRetry = await call(restarted.url, "POST", at + "/promotions", crashRequest); expect(crashRetry.response.status).toBe(201); expect(crashRetry.data).toEqual(crashReceipt.data); expect(counts()).toEqual({ version: { user_version: 5 }, revisions: { n: 3 }, receipts: { n: 2 }, states: [{ state: "promoted", n: 2 }] });
    const source = await call(restarted.url, "GET", at + `/window?centerId=${item.id}`); expect(source.data[0].source.output).toBe("Frozen β");
    const revision = await call(restarted.url, "GET", prefix + `/review-datasets/${receipt.datasetId}/revisions/2`); expect(revision.data.cases[0].sourceOutput).toBe("Frozen β");
    const portable = await call(restarted.url, "GET", prefix + `/review-datasets/${receipt.datasetId}/revisions/2/export`), portableHash = createHash("sha256").update(JSON.stringify(portable.data)).digest("hex"); expect(JSON.stringify(portable.data)).not.toContain(setup.data.user.id); expect(JSON.stringify(portable.data)).not.toContain(runId);
    report = { boots: processes.map(row => ({ pid: row.child.pid, birth: row.birth, url: row.url })), sameDatabase: { inode: before.ino, device: before.dev }, noReseed: true, counters: counts(), receipt, portableHash, frozenOutput: revision.data.cases[0].sourceOutput, crashReceipt: crashRetry.data, canceledFirstReceiptBody: true, hostHomeOverridden: false };
  } finally {
    for (const row of processes) {
      await stop(row.child); let listenerRefused = false;
      try { await fetch(row.url + "/api/team/session", { signal: AbortSignal.timeout(300) }); } catch { listenerRefused = true; }
      reaping.push({ pid: row.child.pid, exitCode: row.child.exitCode, signalCode: row.child.signalCode, listenerRefused });
    }
    rmSync(profile, { recursive: true, force: true });
    const evidence = process.env.RUNPHANTOM_TEAM_PROCESS_EVIDENCE;
    if (evidence && report) writeFileSync(evidence, JSON.stringify({ ...report, reaping, profileDeleted: true }, null, 2) + "\n");
  }
  expect(reaping.every(row => row.listenerRefused)).toBe(true);
}, 30000);
