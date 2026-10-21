import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForElectronTerminal } from "./fixtures/electron/terminal";

function controlledChild() {
  const events = new EventEmitter(); let released = 0;
  const child = Object.assign(events, { stdout: { destroy: () => { released++; } }, stderr: { destroy: () => { released++; } }, unref: () => { released++; } });
  return { child: child as unknown as ChildProcess, events, released: () => released };
}

test("accepted TERM/KILL without terminal confirmation stays unconfirmed by the final deadline", async () => {
  const f = controlledChild(), signals: string[] = [], unrelated = () => {};
  f.events.on("close", unrelated);
  const result = await waitForElectronTerminal(f.child, { isGone: () => false, signal: signal => { signals.push(signal); return true; } },
    { termMs: 5, killMs: 10, finalMs: 20, pollMs: 2 });
  expect(result).toMatchObject({ status: "unconfirmed", leaderClosed: false, groupEmpty: false });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]); expect(f.released()).toBe(3);
  expect(f.events.listeners("close")).toEqual([unrelated]);
});

test("a disappeared owned group is never reacquired or signalled while close remains unknown", async () => {
  const f = controlledChild(); let probes = 0, signals = 0;
  const terminal = await waitForElectronTerminal(f.child, { isGone: () => ++probes === 1, signal: () => { signals++; return true; } },
    { termMs: 5, killMs: 10, finalMs: 20, pollMs: 2 });
  expect(terminal).toMatchObject({ status: "unconfirmed", leaderClosed: false, groupEmpty: true, attemptedSignals: [] });
  expect(probes).toBe(1); expect(signals).toBe(0);
});

test("the leader close event alone cannot confirm an owned process group has terminated", async () => {
  const f = controlledChild();
  const terminal = waitForElectronTerminal(f.child, { isGone: () => false, signal: () => false },
    { termMs: 5, killMs: 10, finalMs: 20, pollMs: 2 });
  f.events.emit("close", 0, null);
  expect(await terminal).toMatchObject({ status: "unconfirmed", leaderClosed: true, groupEmpty: false, code: 0 });
  expect(f.released()).toBe(3);
});

test("confirmation waits for both close and an empty process group and leaves unrelated listeners intact", async () => {
  const f = controlledChild(); let gone = false, confirmed = false;
  const terminal = waitForElectronTerminal(f.child, { isGone: () => gone, signal: () => true },
    { termMs: 100, killMs: 200, finalMs: 300, pollMs: 2 });
  void terminal.then(() => { confirmed = true; });
  f.events.emit("close", 0, null); await new Promise(resolve => setTimeout(resolve, 5));
  expect(confirmed).toBe(false); gone = true;
  expect(await terminal).toMatchObject({ status: "confirmed", leaderClosed: true, groupEmpty: true, attemptedSignals: [] });
  expect(f.released()).toBe(0);
});

test.skipIf(process.platform === "win32")("an actual owned local process is reaped after a bounded signal; this is not Electron proof", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rp-f39-terminal-"));
  const child = spawn(process.execPath, ["--no-env-file", "-e", "setInterval(() => {}, 1000)"], {
    cwd: directory, detached: true, env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory }, stdio: "pipe",
  });
  let confirmed = false;
  try {
    const terminal = await waitForElectronTerminal(child, {
      isGone: () => { if (!child.pid) return true; try { process.kill(-child.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } },
      signal: signal => { if (!child.pid) return false; process.kill(-child.pid, signal); return true; },
    }, { termMs: 50, killMs: 500, finalMs: 2000, pollMs: 5 });
    confirmed = terminal.status === "confirmed";
    expect(terminal.status).toBe("confirmed"); expect(terminal.leaderClosed).toBe(true); expect(terminal.groupEmpty).toBe(true);
    expect(terminal.attemptedSignals[0]?.signal).toBe("SIGTERM");
  } finally {
    // Unknown ownership retains the private directory rather than claiming cleanup.
    if (confirmed) rmSync(directory, { recursive: true, force: true });
  }
});
