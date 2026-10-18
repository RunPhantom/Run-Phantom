import { EventEmitter } from "node:events";
import { copyFile, chmod, mkdir, mkdtemp, open, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileSha256, launchOwnedProcess, observeNative, outsideCheckout, stopOwnedProcess, type OwnedProcess } from "../../app/tests-e2e/daemon-runtime";
import { removeOwnedDirectory } from "../../app/tests-e2e/owned-directory";
import { actualHost, privateEnvironment, sourceIdentity } from "./assembled-executor";
import { canonical, sha256 } from "./assembled-validation";
import type { Host, SourcePin } from "./assembled-contracts";

export async function nativeArtifactMatches(file: string, host: Host): Promise<boolean> {
  const handle = await open(file, "r"), header = Buffer.alloc(4096);
  let bytes = 0; try { bytes = (await handle.read(header, 0, header.length, 0)).bytesRead; } finally { await handle.close(); }
  if (bytes < 64) return false;
  if (host.platform === "darwin") return header.subarray(0, 4).toString("hex") === "cffaedfe" && header.readUInt32LE(4) === (host.arch === "arm64" ? 0x100000c : 0x1000007);
  if (host.platform === "linux") return header.subarray(0, 4).toString("hex") === "7f454c46" && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === (host.arch === "arm64" ? 183 : 62);
  const offset = header.readUInt32LE(60);
  return header.subarray(0, 2).toString() === "MZ" && offset + 6 <= bytes && header.subarray(offset, offset + 4).toString("hex") === "50450000" && header.readUInt16LE(offset + 4) === 0x8664;
}
async function port(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("assembly_port_unavailable")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
export async function probeInstalledBackend(root: string, source: SourcePin, binary: string, digest: string, output: string) {
  if (canonical(sourceIdentity(root)) !== canonical(source)) throw new Error("assembly_candidate_changed");
  const host = actualHost(), original = await realpath(binary);
  if (!/^[a-f0-9]{64}$/.test(digest) || await fileSha256(original) !== digest || !await nativeArtifactMatches(original, host)) throw new Error("assembly_artifact_host_or_digest");
  await mkdir(output);
  const directory = await realpath(output);
  if (!outsideCheckout(root, directory)) throw new Error("assembly_installed_destination_inside_checkout");
  const state = await mkdtemp(path.join(directory, "installed-state-"));
  const bin = path.join(state, process.platform === "win32" ? "runphantom.exe" : "runphantom"), cwd = path.join(state, "empty-cwd"), home = path.join(state, "profile"), temporary = path.join(state, "tmp");
  const owned: OwnedProcess[] = [], closed = new Set<OwnedProcess>(), starts: unknown[] = [], checks: Record<string, unknown> = {};
  const missing = ["application-observed SQLite engine version and live connection settings", "selected enabled/disabled feature and worker resources", "full selected native backend roster", "migration/rollback boundaries", "actual browser-engine UI journeys", "selected provider compatibility and metered output"];
  const failures: string[] = [], logs: { stdout: Buffer; stderr: Buffer; truncated: boolean }[] = []; let removed = false, interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try {
    await mkdir(cwd); await mkdir(home); await mkdir(temporary); await copyFile(original, bin);
    if (process.platform !== "win32") await chmod(bin, (await stat(original)).mode & 0o777);
    if (await fileSha256(bin) !== digest) throw new Error("assembly_copy_digest");
    const listen = await port(), url = `http://127.0.0.1:${listen}`, db = path.join(state, "runphantom.db");
    const env = { ...privateEnvironment(home, temporary), RUNPHANTOM_DB_PATH: db, RUNPHANTOM_SECRET_STORE_PATH: path.join(state, "secrets.json"), RUNPHANTOM_PORT: String(listen), RUNPHANTOM_BIND_HOST: "127.0.0.1" };
    const request = async (route: string, method = "GET", data?: unknown) => {
      if (interrupted) throw new Error("assembly_probe_interrupted");
      const response = await fetch(url + route, { method, headers: { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000) });
      const body = await response.text(); if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("assembly_response_limit");
      return { status: response.status, body };
    };
    const start = async () => {
      const child = launchOwnedProcess(bin, ["serve"], cwd, env); owned.push(child);
      const captured = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false }; logs.push(captured);
      for (const name of ["stdout", "stderr"] as const) child.child[name]?.on("data", (chunk: Buffer) => {
        if (captured[name].length + chunk.length > 64 * 1024) captured.truncated = true;
        if (captured[name].length < 64 * 1024) captured[name] = Buffer.concat([captured[name], chunk.subarray(0, 64 * 1024 - captured[name].length)]);
      });
      await writeFile(path.join(directory, "owned-processes.json"), JSON.stringify(await Promise.all(owned.map(async p => ({ pid: p.child.pid ?? null, identity: await p.identity, closed: closed.has(p) })))));
      const until = Date.now() + 45_000;
      for (;;) {
        if (interrupted) throw new Error("assembly_probe_interrupted");
        if (child.error || child.closeObserved) throw new Error("assembly_installed_start_failed");
        let health: { status: number; body: string } | undefined;
        try { health = await request("/health"); } catch { /* bounded readiness observation */ }
        if (health?.status === 200) {
          const data = JSON.parse(health.body) as { pid: number; service: string; ok: boolean; port: number };
          if (data.pid !== child.child.pid || data.service !== "runphantom" || !data.ok || data.port !== listen) throw new Error("assembly_installed_identity");
          const observation = await observeNative(child.child.pid!, bin, cwd, listen);
          starts.push({ health: data, observation, artifactSha256: await fileSha256(bin), cwd, database: db });
          return child;
        }
        if (Date.now() >= until) throw new Error("assembly_installed_readiness_timeout");
        await Bun.sleep(100);
      }
    };
    const first = await start();
    const empty = await request("/api/runs");
    if (empty.status !== 200 || canonical(JSON.parse(empty.body)) !== "[]") throw new Error("assembly_fresh_database_not_empty");
    checks.initialEmptyDatabase = true;
    const id = "f4500000000000000000000000000001", span = "f450000000000001";
    const trace = { format: "runphantom-trace/v1", run: { id, name: "assembled-owned-control", started_at: 1, last_updated_at: 2 }, spans: [{ id: span, run_id: id, name: "owned-real-import", start_time_ms: 1, end_time_ms: 2, duration_ms: 1 }], liveEvents: [], annotations: [] };
    const imported = await request("/api/import-run", "POST", trace);
    if (imported.status !== 200 || (JSON.parse(imported.body) as { runId: string }).runId !== id) throw new Error("assembly_real_import_failed");
    const exported = await request(`/api/runs/${id}/export`); const actual = JSON.parse(exported.body) as { run: { id: string }; spans: { id: string }[] };
    if (exported.status !== 200 || actual.run.id !== id || actual.spans.length !== 1 || actual.spans[0].id !== span) throw new Error("assembly_actual_export_mismatch");
    checks.importAndExport = { runId: id, spanId: span, exportSHA256: sha256(canonical(actual)) };
    const invalid = await request("/api/import-run", "POST", { format: "invalid" });
    if (invalid.status !== 400) throw new Error("assembly_malformed_import_not_refused"); checks.malformedImportRefused = true;
    const ui = await request("/"); if (ui.status !== 200 || !ui.body.includes("<html")) throw new Error("assembly_embedded_ui_missing");
    checks.embeddedHTML = { sha256: sha256(ui.body), bytes: Buffer.byteLength(ui.body), scope: "HTML availability only; no browser or font execution" };
    await stopOwnedProcess(first); closed.add(first);
    const second = await start(); if (first.child.pid === second.child.pid) throw new Error("assembly_restart_identity");
    const after = await request(`/api/runs/${id}/export`);
    if (after.status !== 200 || canonical(JSON.parse(after.body)) !== canonical(actual)) throw new Error("assembly_restart_output_changed");
    checks.restart = { firstPid: first.child.pid, secondPid: second.child.pid, firstClosedBeforeRestart: true, sameDatabase: true, beforeSHA256: sha256(canonical(actual)), afterSHA256: sha256(canonical(JSON.parse(after.body))) };
    if (await fileSha256(original) !== digest || await fileSha256(bin) !== digest) throw new Error("assembly_artifact_changed");
    await writeFile(path.join(directory, "actual-import-export.json"), JSON.stringify({ imported, exported, after, invalid }, null, 2));
  } catch (error) { failures.push(error instanceof Error && /^assembly_[a-z_]+$/.test(error.message) ? error.message : "assembly_probe_failed"); }
  finally {
    const cleanup = await Promise.allSettled(owned.filter(p => !closed.has(p)).map(async p => { await stopOwnedProcess(p); closed.add(p); }));
    if (cleanup.some(r => r.status === "rejected")) failures.push("assembly_owned_cleanup_failed");
    if (owned.every(p => closed.has(p))) {
      try { await removeOwnedDirectory(state); removed = true; } catch { failures.push("assembly_profile_remove_failed"); }
    }
    await writeFile(path.join(directory, "owned-processes.json"), JSON.stringify(await Promise.all(owned.map(async p => ({ pid: p.child.pid ?? null, identity: await p.identity, closed: closed.has(p) })))));
    EventEmitter.prototype.removeListener.call(process, "SIGINT", onSignal); EventEmitter.prototype.removeListener.call(process, "SIGTERM", onSignal);
  }
  const logFacts = [];
  for (const [index, log] of logs.entries()) {
    for (const name of ["stdout", "stderr"] as const) await writeFile(path.join(directory, `boot-${index + 1}-${name}.log`), log[name]);
    logFacts.push({ boot: index + 1, stdoutBytes: log.stdout.length, stdoutSha256: sha256(log.stdout), stderrBytes: log.stderr.length, stderrSha256: sha256(log.stderr), truncated: log.truncated });
    if (log.truncated) failures.push("assembly_probe_output_limit");
  }
  try { if (canonical(sourceIdentity(root)) !== canonical(source)) failures.push("assembly_candidate_changed"); }
  catch { failures.push("assembly_candidate_changed"); }
  const result = { schema: "runphantom.assembly-installed-probe/v1", source, artifactSHA256: digest, actualHost: host,
    launcherRuntimeVersion: Bun.version, applicationRuntimeVersion: null, applicationDatabaseSettings: null,
    status: failures.length ? "failed" : "observed-partial", checks, starts, logFacts, cleanup: { allOwnedClosed: owned.every(p => closed.has(p)), profileRemoved: removed },
    failures, missing, releaseQualified: false, scope: "Owned default installed backend import/export/restart/HTML probe only; cannot fill a full installed, platform or assembled cell" };
  await writeFile(path.join(directory, "probe-result.json"), JSON.stringify(result, null, 2)); return result;
}
