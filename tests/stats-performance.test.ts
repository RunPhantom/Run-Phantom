import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { closeDb, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";
import { clearRunFactsCache } from "../src/stats/run-facts";
import { seedMetricsRuns } from "./fixtures/metrics-seed";

const RUNS = 5_000;
const SAMPLES = 30;
const ROUNDS = 3;
let directory: string;
let oldDb: string | undefined;
let server: Server;
let origin: string;

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-stats-perf-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  clearRunFactsCache();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "perf.db");
  seedMetricsRuns(getDrizzleDb().$client, { runs: RUNS, now: Date.now() });
  ({ server } = await createServer(0));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server?.close();
  clearRunFactsCache();
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

async function timed(route: string): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${origin}${route}`);
  await response.arrayBuffer();
  expect(response.status).toBe(200);
  return performance.now() - started;
}

test(`overview and run list stay under 150 ms at p95 over ${RUNS.toLocaleString()} runs`, async () => {
  const cold = await timed("/api/overview?window=30d");
  const routes = ["/api/overview?window=30d", "/api/overview?window=24h", "/api/runs?limit=100&sort=cost", "/api/runs?limit=100&status=failed", "/api/runs"];
  const report: string[] = [`cold 30d overview ${cold.toFixed(0)}ms`];
  for (const route of routes) {
    await timed(route);
    const rounds: string[] = [];
    let best = Infinity;
    // Other processes on a shared machine can stall a whole round; a regression fails every round.
    for (let round = 0; round < ROUNDS && best >= 150; round++) {
      const samples: number[] = [];
      for (let index = 0; index < SAMPLES; index++) samples.push(await timed(route));
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.ceil(0.95 * samples.length) - 1];
      best = Math.min(best, p95);
      rounds.push(`p50 ${samples[Math.floor(samples.length / 2)].toFixed(1)}ms p95 ${p95.toFixed(1)}ms`);
    }
    report.push(`${route} ${rounds.join(" | ")}`);
    expect(best).toBeLessThan(150);
  }
  console.log(`Stats benchmark (${RUNS} runs): ${report.join("; ")}`);
  expect(cold).toBeLessThan(3_000);
}, 120_000);
