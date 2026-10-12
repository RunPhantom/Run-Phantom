import { test, expect } from "./fixtures";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

test("runtime fixture starts a fresh daemon for the selected execution mode", async ({ request, runPhantom }) => {
  const health = await request.get(`${runPhantom.url}/health`);
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({ service: "runphantom", pid: runPhantom.runtime.pid, port: runPhantom.port });
  if (process.env.PHANTOM_NATIVE_INTERRUPT_RECEIPT) {
    await writeFile(process.env.PHANTOM_NATIVE_INTERRUPT_RECEIPT, JSON.stringify({ runtime: runPhantom.runtime, url: runPhantom.url, workerPid: process.pid, runnerPid: process.ppid }));
    await new Promise<void>(() => {});
  }
  const runs = await request.get(`${runPhantom.url}/api/runs`);
  expect(runs.ok()).toBe(true);
  expect(await runs.json()).toEqual([]);
  expect((await stat(runPhantom.dbPath)).isFile()).toBe(true);
  expect(path.dirname(runPhantom.dbPath)).toBe(runPhantom.runtime.stateDirectory);
  expect(path.dirname(runPhantom.runtime.profile)).toBe(runPhantom.runtime.stateDirectory);
  if (process.env.RUNPHANTOM_E2E_RUNTIME === "installed") {
    const runtime = runPhantom.runtime;
    expect(runtime.mode).toBe("installed");
    expect(runtime.copiedArtifact).not.toBe(runtime.sourceArtifact);
    expect(runtime.sourceSha256).toBe(process.env.RUNPHANTOM_E2E_SHA256);
    expect(runtime.copiedSha256).toBe(runtime.sourceSha256);
    expect(runtime.command).toEqual([runtime.copiedArtifact, "serve"]);
    expect(runtime.observation?.listenerOwned).toBe(true);
    expect(runtime.observation?.cwdEvidence).toBe(process.platform === "win32" ? "launch-only" : "observed");
    expect(runtime.observation?.cwd).toBe(process.platform === "win32" ? null : runtime.cwd);
    expect(await readdir(runtime.cwd)).toEqual([]);
  } else {
    expect(runPhantom.runtime.mode).toBe("source");
    expect(runPhantom.runtime.copiedArtifact).toBeNull();
    expect(runPhantom.runtime.observation).toBeNull();
  }
});
