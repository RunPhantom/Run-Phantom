import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-request-lifecycle-"));
const owned: ChildProcess[] = [];
afterAll(() => {
  for (const proc of owned) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(directory, { recursive: true, force: true });
});

async function startDaemon(name: string) {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const home = path.join(directory, name); mkdirSync(path.join(home, "real"), { recursive: true });
  // The secret store refuses symlinked path components, which makes key lookups throw inside async routes.
  symlinkSync(path.join(home, "real"), path.join(home, "linked"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)));
  const daemon = spawn("bun", ["src/index.ts", "serve"], { cwd: path.resolve(import.meta.dir, ".."), stdio: "ignore", env: { ...env,
    HOME: home, USERPROFILE: home, RUNPHANTOM_DB_PATH: path.join(home, "rp.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(home, "linked", "secrets.json"),
    RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  owned.push(daemon);
  const exited = once(daemon, "exit");
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    try { const health = await fetch(base + "/health"); if (health.ok && (await health.json()).pid === daemon.pid) return { daemon, exited, base, port }; } catch { /* Await owned health. */ }
    await Bun.sleep(25);
  }
  throw new Error("daemon failed to become healthy");
}

async function exitsWithin(exited: Promise<unknown>, ms: number) {
  return Promise.race([exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

test("a rejected async route is answered instead of left hanging", async () => {
  const { daemon, exited, base } = await startDaemon("rejected-route");
  const response = await fetch(base + "/api/models/anthropic", { signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "request failed" });
  daemon.kill("SIGTERM");
  expect(await exitsWithin(exited, 5000)).toBe(true);
}, 20000);

test("SIGTERM exits while a request is still in flight", async () => {
  const { daemon, exited, port } = await startDaemon("in-flight");
  const socket = connect(port, "127.0.0.1"); await once(socket, "connect");
  socket.on("error", () => {});
  // Headers promise a body that never arrives, so the request stays in flight.
  socket.write("POST /api/import-run HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{");
  await Bun.sleep(300);
  daemon.kill("SIGTERM");
  expect(await exitsWithin(exited, 5000)).toBe(true);
  socket.destroy();
}, 20000);
