import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

export interface StatsBenchmarkResult {
  runs: number;
  coldMs: number;
  routes: Array<{ route: string; rounds: Array<{ p50: number; p95: number }> }>;
}

const RUNS = Number(process.argv[2] ?? 5_000);
const SAMPLES = 30;
const ROUNDS = 3;
const BUDGET_MS = 150;
const ROUTES = ["/api/overview?window=30d", "/api/overview?window=24h", "/api/runs?limit=100&sort=cost", "/api/runs?limit=100&status=failed", "/api/runs"];

const directory = mkdtempSync(path.join(tmpdir(), "rp-stats-perf-"));
process.env.RUNPHANTOM_DB_PATH = path.join(directory, "perf.db");
const { closeDb, getDrizzleDb } = await import("../../src/db");
const { createServer } = await import("../../src/server");
const { seedMetricsRuns } = await import("./metrics-seed");
try {
  seedMetricsRuns(getDrizzleDb().$client, { runs: RUNS, now: Date.now() });
  const { server } = await createServer(0);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const timed = async (route: string) => {
    const started = performance.now();
    const response = await fetch(`${origin}${route}`);
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error(`${route} answered ${response.status}`);
    return performance.now() - started;
  };
  const result: StatsBenchmarkResult = { runs: RUNS, coldMs: await timed(ROUTES[0]), routes: [] };
  for (const route of ROUTES) {
    await timed(route);
    const rounds: Array<{ p50: number; p95: number }> = [];
    // Other processes on a shared machine can stall a whole round; a regression fails every round.
    while (rounds.length < ROUNDS && !rounds.some(round => round.p95 < BUDGET_MS)) {
      const samples: number[] = [];
      for (let index = 0; index < SAMPLES; index++) samples.push(await timed(route));
      samples.sort((a, b) => a - b);
      rounds.push({ p50: samples[Math.floor(samples.length / 2)], p95: samples[Math.ceil(0.95 * samples.length) - 1] });
    }
    result.routes.push({ route, rounds });
  }
  server.close();
  console.log(JSON.stringify(result));
} finally {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
}
process.exit(0);
