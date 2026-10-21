import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { capabilityOwnerKey } from "../src/coding-hooks/capability";
import { cursorHook } from "./fixtures/coding-hooks-cursor";

test.skipIf(process.platform === "win32")("fresh actual source daemon and public Cursor CLI use a default private HOME profile", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "f13-default-process-"))), home = path.join(directory, "private home"), workspace = path.join(directory, "actual workspace"); mkdirSync(home); mkdirSync(workspace);
  const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const value = server.address(); if (!value || typeof value === "string") { server.close(); reject(new Error("port unavailable")); return; } server.close(error => error ? reject(error) : resolve(value.port)); }); });
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: directory, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", RUNPHANTOM_CODEX_CLI_CHAT: "0" };
  expect(Object.hasOwn(env, "RUNPHANTOM_DB_PATH")).toBe(false);
  const owned = new Map<ChildProcess, Promise<void>>();
  function child(command: string, args: string[]) {
    const process = spawn(command, args, { cwd: path.resolve(import.meta.dir, ".."), env, detached: true, stdio: "pipe" });
    let out = "", err = "";
    const bounded = (value: Buffer, which: "out" | "err") => { if (out.length + err.length + value.length > 32768) { try { globalThis.process.kill(-process.pid!, "SIGKILL"); } catch { /* Already terminal. */ } return; } if (which === "out") out += value.toString(); else err += value.toString(); };
    process.stdout.on("data", value => bounded(value, "out")); process.stderr.on("data", value => bounded(value, "err")); process.stdin.on("error", () => {});
    const closed = new Promise<void>((resolve, reject) => { process.once("close", () => resolve()); process.once("error", reject); }); owned.set(process, closed);
    return { process, closed, output: () => ({ out, err }) };
  }
  async function terminal(process: ChildProcess, closed: Promise<void>) {
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
    const timer = setTimeout(() => { try { globalThis.process.kill(-process.pid!, "SIGKILL"); } catch { /* Already terminal. */ } }, 2500);
    try { await Promise.race([closed, new Promise<never>((_, reject) => { const last = setTimeout(() => reject(new Error("owned child did not close")), 5000); void closed.then(() => clearTimeout(last), () => clearTimeout(last)); })]); }
    finally { clearTimeout(timer); }
    expect(() => globalThis.process.kill(-process.pid!, 0)).toThrow();
  }
  const daemon = child(process.execPath, ["--no-env-file", "src/index.ts", "serve"]); daemon.process.stdin.end();
  let bodyFailed = false, primary: unknown; const cleanupErrors: unknown[] = [];
  try {
    const started = performance.now(); let health: { pid: number } | undefined;
    while (performance.now() - started < 5000) {
      if (daemon.process.exitCode !== null || daemon.process.signalCode !== null) throw new Error("owned source daemon ended before readiness");
      try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) }); if (response.ok) { health = await response.json() as { pid: number }; break; } } catch { /* Readiness probe only. */ }
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    expect(health?.pid).toBe(daemon.process.pid);
    const database = path.join(home, ".runphantom/runphantom.db"); expect(existsSync(database)).toBe(true);
    const install = child(process.execPath, ["--no-env-file", "src/index.ts", "hooks", "install", "cursor", "--local", "--cwd", workspace, "--full", "--consent-full"]); install.process.stdin.end();
    const timer = setTimeout(() => { try { process.kill(-install.process.pid!, "SIGKILL"); } catch { /* Already terminal. */ } }, 4000);
    try { await install.closed; } finally { clearTimeout(timer); }
    expect(install.process.exitCode).toBe(0); expect(install.output().err).toBe(""); const receipt = JSON.parse(install.output().out) as { installationId: string; policy: string }; expect(receipt.policy).toBe("active"); expect(install.output().out).not.toMatch(/Bearer|ownerGeneration|token/);
    const settings = JSON.parse(readFileSync(path.join(workspace, ".cursor/hooks.json"), "utf8")) as { hooks: { afterAgentResponse: { command: string }[] } };
    const callback = child("/bin/sh", ["-c", settings.hooks.afterAgentResponse[0].command]); callback.process.stdin.end(cursorHook("afterAgentResponse", { cwd: workspace, workspace_roots: [workspace] }));
    const callbackTimer = setTimeout(() => { try { process.kill(-callback.process.pid!, "SIGKILL"); } catch { /* Already terminal. */ } }, 2500);
    try { await callback.closed; } finally { clearTimeout(callbackTimer); }
    expect(callback.process.exitCode).toBe(0); expect(callback.output()).toEqual({ out: "", err: "" });
    const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json() as { id: string; finished: number }[]; expect(runs).toHaveLength(1); expect(runs[0].finished).toBe(0);
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/runs/detail/${runs[0].id}`)).json(); expect(JSON.stringify(detail.spans)).toContain("Captured synthetic Cursor answer");
    const globals = [path.join(directory, "global workspace A"), path.join(directory, "global workspace B")]; globals.forEach(p => mkdirSync(p));
    const manageGlobal = async (action: string, workspace: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": capabilityOwnerKey(database) }, body: JSON.stringify({ action, vendor: "cursor", scope: "global", workspace, captureMode: "metadata", fullConsent: false }) });
      expect(response.status).toBe(200); return response.json() as Promise<{ registrationCount: number }>;
    };
    expect((await manageGlobal("install", globals[0])).registrationCount).toBe(1); expect((await manageGlobal("install", globals[1])).registrationCount).toBe(2);
    const globalSettings = JSON.parse(readFileSync(path.join(home, ".cursor/hooks.json"), "utf8")) as typeof settings;
    const observe = async (workspace: string, generation: string) => {
      const observer = child("/bin/sh", ["-c", globalSettings.hooks.afterAgentResponse[0].command]);
      observer.process.stdin.end(cursorHook("afterAgentResponse", { cwd: workspace, workspace_roots: [workspace], generation_id: generation }));
      const timer = setTimeout(() => { try { process.kill(-observer.process.pid!, "SIGKILL"); } catch { /* Already terminal. */ } }, 2500);
      try { await observer.closed; } finally { clearTimeout(timer); }
      expect(observer.process.exitCode).toBe(0); expect(observer.output()).toEqual({ out: "", err: "" });
    };
    await observe(globals[0], "first"); await observe(globals[1], "first");
    const allRuns = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json() as { id: string }[]; expect(allRuns).toHaveLength(3);
    const globalIds = allRuns.filter(r => r.id !== runs[0].id).map(r => r.id);
    const readDetails = async () => Promise.all(globalIds.map(async id => (await (await fetch(`http://127.0.0.1:${port}/api/runs/detail/${id}`)).json()) as { spans: { output_payload: string | null }[] }));
    const before = await readDetails(); expect(before.every(d => d.spans.length === 2 && d.spans.every(s => s.output_payload === null))).toBe(true);
    expect((await manageGlobal("unregister", globals[0])).registrationCount).toBe(1); await observe(globals[0], "revoked"); expect(await readDetails()).toEqual(before);
    await observe(globals[1], "still-registered"); expect((await readDetails()).map(d => d.spans.length).sort()).toEqual([2, 3]);
    console.log("F13_DEFAULT_PROFILE", JSON.stringify({ daemonPid: daemon.process.pid, healthPid: health?.pid, defaultDatabase: true, dbOverride: false, cliExit: install.process.exitCode, callbackExit: callback.process.exitCode, vendor: "synthetic fixture, not installed Cursor" }));
  } catch (error) { bodyFailed = true; primary = error; } finally {
    for (const [process, closed] of [...owned].reverse()) { try { await terminal(process, closed); } catch (error) { cleanupErrors.push(error); } }
    if (!cleanupErrors.length) { try { rmSync(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); } }
  }
  if (cleanupErrors.length) throw new AggregateError([...(bodyFailed ? [primary] : []), ...cleanupErrors], "Owned source process cleanup unavailable; private profile retained");
  if (bodyFailed) throw primary;
}, 20000);
