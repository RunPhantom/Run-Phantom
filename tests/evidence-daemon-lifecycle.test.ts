import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";

const entry = resolve(import.meta.dir, "../src/index.ts");
const small = Buffer.from('<testsuite tests="1"><testcase name="restart control"/></testsuite>');
function encode(key: string, bytes = small) {
  const metadata = Buffer.from(JSON.stringify({ version: 1, request: { ...EVIDENCE_READER_IDENTITY, operationKey: key,
    attachment: { kind: "run", id: "native-run" }, target: null, inventory: null, retention: "raw_and_normalized",
    sources: [{ sourceId: "unit", shardId: "unit", kind: "junit", dialect: "junit-xml/v1", artifactSha256: evidenceDigest(bytes), byteLength: bytes.length }] } }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length); return Buffer.concat([prefix, metadata, bytes]);
}
async function until(condition: () => boolean | Promise<boolean>, ms = 4_000) {
  const deadline = performance.now() + ms;
  while (!await condition()) { if (performance.now() > deadline) throw new Error("Owned native process condition exceeded its deadline"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function gone(pid: number) { try { process.kill(pid, 0); return false; } catch { return true; } }
async function qualify(command: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "runphantom-f04-daemon-")), cwd = join(directory, "empty-cwd"), profile = join(directory, "private-profile"), database = join(profile, "actual.db");
  mkdirSync(cwd); mkdirSync(profile);
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()));
  const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = { HOME: profile, USERPROFILE: profile, RUNPHANTOM_DB_PATH: database, RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", LANG: "C.UTF-8", TZ: "UTC" };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let diagnostics: Promise<string> | undefined;
  const sockets: ReturnType<typeof httpRequest>[] = [];
  const workers: number[] = [];
  const query = (sql: string) => { const db = new Database(database); try { return db.query(sql).get() as Record<string, unknown>; } finally { db.close(); } };
  async function launch() {
    child = Bun.spawn([...command, "serve"], { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    diagnostics = new Response(child.stderr).text();
    await until(async () => { if (child!.exitCode !== null) throw new Error("Owned daemon exited before health"); try { return (await fetch(`${base}/health`)).ok; } catch { return false; } });
    expect((await (await fetch(`${base}/health`)).json()).pid).toBe(child.pid);
  }
  async function stop(signal: "SIGINT" | "SIGTERM" | "SIGUSR2" | "SIGKILL", expected: number | null) {
    process.kill(child!.pid, signal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let exit: number;
    try { exit = await Promise.race([child!.exited, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Exit deadline")), 4_000); })]); }
    catch { child!.kill("SIGKILL"); await child!.exited; throw new Error(`Owned daemon did not finish ${signal}: ${(await diagnostics ?? "").slice(0, 4_096)}`); }
    finally { clearTimeout(timeout); }
    if (expected !== null) { if (exit !== expected) throw new Error(`Owned daemon exited ${exit}: ${(await diagnostics ?? "").slice(0, 4_096)}`); expect(exit).toBe(expected); }
    expect(gone(child!.pid)).toBe(true);
  }
  function partial(key: string) {
    const bytes = encode(key), end = 4 + bytes.readUInt32BE(0);
    const request = httpRequest(`${base}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } }, response => response.resume());
    request.on("error", () => {}); request.write(bytes.subarray(0, end + 1)); sockets.push(request);
  }
  async function upload(key: string, bytes = small) {
    const response = await fetch(`${base}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: encode(key, bytes) });
    expect(response.status).toBe(202); return (await response.json()).job;
  }
  async function completed(id: string) {
    let result: { status: string; setId: string } | undefined;
    await until(async () => { result = (await (await fetch(`${base}/api/evaluations/evidence/imports/${id}`)).json()).job; return result?.status === "completed"; });
    return result!;
  }
  try {
    await launch(); const db = new Database(database); db.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('native-run',1,1)"); db.close();
    const original = await completed((await upload("persisted-control")).id);
    const originalExport = await (await fetch(`${base}/api/evaluations/evidence/sets/${original.setId}/export`)).text();
    for (const signal of ["SIGINT", "SIGUSR2"] as const) {
      partial(`partial-${signal}`); await until(() => query(`SELECT status FROM evaluation_evidence_jobs WHERE operation_key='partial-${signal}'`)?.status === "running");
      await stop(signal, 0);
      expect(query(`SELECT status,failure_code,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE operation_key='partial-${signal}'`)).toEqual({ status: "failed", failure_code: "shutdown", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
      await launch();
    }
    // Observe the actual production child while a bounded large source is being processed.
    const large = Buffer.from(`<testsuite tests="35000">${'<testcase name="bounded large"/>'.repeat(35_000)}</testsuite>`);
    await upload("worker-shutdown", large);
    await until(() => {
      const ps = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
      const row = ps.stdout.toString().split("\n").find(line => Number(line.trim().split(/\s+/)[1]) === child!.pid &&
        (line.includes("__runphantom_evidence_worker_v1") || line.includes("/evaluations/evidence-worker.ts")));
      if (row) { workers.push(Number(row.trim().split(/\s+/)[0])); return true; } return false;
    });
    await stop("SIGTERM", 0); expect(workers.every(gone)).toBe(true);
    expect(query("SELECT status,failure_code,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE operation_key='worker-shutdown'")).toEqual({ status: "failed", failure_code: "shutdown", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
    await launch(); partial("crashed-upload"); await until(() => query("SELECT status FROM evaluation_evidence_jobs WHERE operation_key='crashed-upload'")?.status === "running");
    await stop("SIGKILL", null); await launch();
    expect(query("SELECT status,failure_code,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE operation_key='crashed-upload'")).toEqual({ status: "failed", failure_code: "restart_interrupted", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
    expect(await (await fetch(`${base}/api/evaluations/evidence/sets/${original.setId}/export`)).text()).toBe(originalExport);
    expect((await completed((await upload("after-owned-restart")).id)).status).toBe("completed");
    expect(query("SELECT count(*) AS n FROM evaluation_evidence_blobs")).toEqual({ n: 2 });
    await stop("SIGTERM", 0);
  } finally {
    sockets.forEach(socket => socket.destroy());
    if (child && child.exitCode === null) child.kill("SIGKILL"); if (child) await child.exited;
    workers.forEach(pid => { if (!gone(pid)) process.kill(pid, "SIGKILL"); });
    rmSync(directory, { recursive: true, force: true });
  }
}

// Windows process and signal qualification runs in its dedicated native workflow; /bin/ps is a POSIX ownership oracle.
test.skipIf(process.platform === "win32")("source daemon awaits live uploads and real worker exit across signals and process restart", async () => {
  await qualify([process.execPath, "--no-env-file", "--no-install", entry]);
}, 30_000);
test.skipIf(process.platform === "win32" || !process.env.RUNPHANTOM_F04_TEST_BINARY)("copied application performs real import, signal reaping and restart outside the checkout", async () => {
  await qualify([resolve(process.env.RUNPHANTOM_F04_TEST_BINARY!)]);
}, 30_000);

test.skipIf(process.platform === "win32")("an actual uncaught exception preserves failure exit while shutting down a live upload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runphantom-f04-fatal-")), marker = join(directory, "throw-now"), database = join(directory, "actual.db");
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(done => reservation.close(() => done()));
  // This private launcher injects an actual exception after admission; there is no application fault endpoint.
  const script = `import {existsSync} from "node:fs"; process.argv=[process.execPath,${JSON.stringify(entry)},"serve"]; setInterval(()=>{if(existsSync(${JSON.stringify(marker)}))throw Error("synthetic fatal lifecycle fixture")},10); await import(${JSON.stringify(entry)});`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", script], { cwd: directory, env: { HOME: directory, RUNPHANTOM_DB_PATH: database, RUNPHANTOM_PORT: String(port), LANG: "C.UTF-8", TZ: "UTC" }, stdout: "ignore", stderr: "ignore" });
  let socket: ReturnType<typeof httpRequest> | undefined;
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
    const db = new Database(database); db.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('native-run',1,1)");
    const bytes = encode("fatal-upload"), end = 4 + bytes.readUInt32BE(0);
    socket = httpRequest(`http://127.0.0.1:${port}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } }, response => response.resume()); socket.on("error", () => {}); socket.write(bytes.subarray(0, end + 1));
    await until(() => (db.query("SELECT status FROM evaluation_evidence_jobs WHERE operation_key='fatal-upload'").get() as { status: string } | null)?.status === "running");
    writeFileSync(marker, "throw"); await until(() => child.exitCode !== null); expect(await child.exited).toBe(1); expect(gone(child.pid)).toBe(true);
    expect(db.query("SELECT status,failure_code,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE operation_key='fatal-upload'").get()).toEqual({ status: "failed", failure_code: "shutdown", reserved_normalized_bytes: 0 }); db.close();
  } finally { socket?.destroy(); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
