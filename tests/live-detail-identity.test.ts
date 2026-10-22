import { expect, test } from "bun:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { closeDb, getLiveEvents, upsertLiveEvent } from "../src/db";
import { createServer } from "../src/server";

const runId = "00000000000000000000000000000001";
const coverage = "x-runphantom-live-events";
async function observed(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Expected real WebSocket frame was not received");
    await Bun.sleep(10);
  }
}
type Frame = { event: string; data: { traceId?: string; persistedId?: number; content?: string } };

async function withStore(body: (url: string, frames: Frame[]) => Promise<void>) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-live-identity-")));
  const keys = ["RUNPHANTOM_DB_PATH", "RUNPHANTOM_SECRET_STORE_PATH"] as const;
  const previous = keys.map(key => process.env[key]);
  let server: Awaited<ReturnType<typeof createServer>>["server"] | undefined;
  let socket: WebSocket | undefined;
  const errors: unknown[] = [];
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "events.db");
  process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, "secrets.json");
  try {
    ({ server } = await createServer(0));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const frames: Frame[] = [];
    socket = new WebSocket(url.replace("http:", "ws:") + "/ws");
    socket.on("message", data => frames.push(JSON.parse(data.toString()) as Frame));
    await once(socket, "open");
    await body(url, frames);
  } catch (error) { errors.push(error); }
  finally {
    try {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }
    } catch (error) { errors.push(error); }
    try {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    } catch (error) { errors.push(error); }
    try { closeDb(); } catch (error) { errors.push(error); }
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    try { rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Live identity fixture failed", { cause: errors[0] });
}

function post(url: string, route: string, data?: unknown) {
  return fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}) });
}

function trace(events: unknown[] = []) {
  return {
    run: { id: runId, name: "saved identity", started_at: 1, last_updated_at: 2 },
    spans: [{ id: "0000000000000001", run_id: runId, name: "saved span", span_type: "TOOL_CALL", status: "OK", start_time_ms: 1, end_time_ms: 2, duration_ms: 1 }],
    liveEvents: events,
  };
}

test("a live insert returns the actual row ID and identical events remain distinct", () => withStore(async () => {
  const event = { traceId: runId, type: "reasoning", content: "same", timestamp: 10 };
  const first = upsertLiveEvent(event);
  const second = upsertLiveEvent(event);
  const rows = getLiveEvents(runId);
  expect(rows).toHaveLength(2);
  expect(first).toBe(rows[0].id);
  expect(second).toBe(rows[1].id);
  expect(rows[0].id).not.toBe(rows[1].id);
}));

test("real HTTP live frames carry the two exact persisted IDs without changing input or response", () => withStore(async (url, frames) => {
  for (let i = 0; i < 2; i++) {
    const result = await post(url, "/v1/live", { traceId: runId, type: "reasoning", content: "same", timestamp: 10, metadata: { fixture: true }, persistedId: 987654321 });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
  }
  await observed(() => frames.filter(frame => frame.event === "live").length === 2);
  const response = await fetch(`${url}/api/runs/detail/${runId}`);
  const data = await response.json() as { liveEvents: { id: number }[] };
  expect(frames.filter(frame => frame.event === "live").map(frame => frame.data.persistedId)).toEqual(data.liveEvents.map(row => row.id));
  expect(data.liveEvents.map(row => row.id)).not.toContain(987654321);
  expect(response.headers.get(coverage)).toBe("current-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  const refused = await fetch(`${url}/api/runs/detail/${runId}`, { headers: { Origin: "https://untrusted.invalid" } });
  expect(refused.status).toBe(403);
  expect(refused.headers.get("access-control-allow-origin")).toBeNull();
}));

test("an actual scheduled demo live frame carries its native database row ID", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-demo-identity-")));
  const proc = spawn(process.execPath, ["--no-env-file", path.join(import.meta.dir, "fixtures/live-demo-identity.ts")], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, HOME: directory, USERPROFILE: directory,
      RUNPHANTOM_DB_PATH: path.join(directory, "demo.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  proc.stdout?.on("data", data => { output += data.toString(); });
  proc.stderr?.on("data", data => { errors += data.toString(); });
  const exited = once(proc, "exit");
  const deadline = setTimeout(() => proc.kill("SIGTERM"), 4000);
  try {
    const [code] = await exited;
    expect(code, errors).toBe(0);
    const receipt = JSON.parse(output.split("\n").find(line => line.startsWith("DEMO_IDENTITY "))!.slice(14));
    expect(receipt.persistedId).toBe(receipt.rowId);
    expect(Number.isSafeInteger(receipt.rowId)).toBe(true);
    expect(receipt.content).toBe(receipt.rowContent);
  } finally {
    clearTimeout(deadline);
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGKILL"); await exited; }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a live-only cached fallback covers real pre-request events and leaves stored history unchanged", () => withStore(async (url, frames) => {
  expect((await post(url, "/api/import-run", trace([{ type: "reasoning", content: "historical", timestamp: 1 }]))).ok).toBe(true);
  const cached = await (await fetch(`${url}/api/runs/detail/${runId}`)).json();
  expect((await fetch(`${url}/api/saved-runs/cache/${runId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cached) })).ok).toBe(true);
  expect((await post(url, "/api/clear")).ok).toBe(true);
  expect((await post(url, "/v1/live", { traceId: runId, type: "reasoning", content: "after cache", timestamp: 20 })).ok).toBe(true);
  await observed(() => frames.some(frame => frame.event === "live" && frame.data.content === "after cache"));
  const response = await fetch(`${url}/api/runs/detail/${runId}`);
  const data = await response.json() as { spans: unknown[]; liveEvents: { id: number; content: string }[] };
  expect(data.liveEvents.map(row => row.id)).toEqual(getLiveEvents(runId).map(row => row.id));
  expect(data.liveEvents.map(row => row.content)).toEqual(["after cache"]);
  expect(response.headers.get(coverage)).toBe("current-store");
  expect(data.spans).toEqual((cached as { spans: unknown[] }).spans);
  expect(await (await fetch(`${url}/api/saved-runs/cache/${runId}`)).json()).toEqual(cached);
}));

test("saved-only fallback retains its complete historical list after clear", () => withStore(async url => {
  expect((await post(url, "/api/import-run", trace([{ type: "reasoning", content: "same", timestamp: 1 }, { type: "reasoning", content: "same", timestamp: 1 }]))).ok).toBe(true);
  const cached = await (await fetch(`${url}/api/runs/detail/${runId}`)).json();
  await fetch(`${url}/api/saved-runs/cache/${runId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cached) });
  await post(url, "/api/clear");
  const response = await fetch(`${url}/api/runs/detail/${runId}`);
  expect(await response.json()).toEqual(cached);
  expect(response.headers.get(coverage)).toBe("saved-cache");
  expect(getLiveEvents(runId)).toHaveLength(0);
}));

test("import replacement is current-store coverage and does not revive removed rows", () => withStore(async url => {
  await post(url, "/api/import-run", trace([{ type: "reasoning", content: "old", timestamp: 1 }]));
  const oldId = getLiveEvents(runId)[0].id;
  await post(url, "/api/import-run", trace([{ type: "reasoning", content: "replacement", timestamp: 2 }]));
  const response = await fetch(`${url}/api/runs/detail/${runId}`);
  const data = await response.json() as { liveEvents: { id: number; content: string }[] };
  expect(data.liveEvents).toEqual(getLiveEvents(runId));
  expect(data.liveEvents[0].id).not.toBe(oldId);
  expect(data.liveEvents[0].content).toBe("replacement");
  expect(response.headers.get(coverage)).toBe("current-store");
}));
