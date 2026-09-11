import { expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { REPO_ROOT_PATH } from "./fixtures";

export const FIXTURE_PRIMARY_RUN_ID = "00000000000000000000000000000001";
export const FIXTURE_SAVED_SIBLING_RUN_ID = "00000000000000000000000000000002";
export const FIXTURE_LIVE_RUN_ID = "00000000000000000000000000000003";
export const FIXTURE_DISPLAY_NAME = "agent.turn";
export const FIXTURE_SPAN_COUNT = 6;

type RunPhantomDetailResponse = {
  run: {
    id: string;
    event_name?: string | null;
    name?: string | null;
    user_id?: string | null;
    convo_id?: string | null;
    started_at: number;
  };
};

export async function seedRunPhantomFixtures(runPhantomUrl: string): Promise<void> {
  const seed = spawnSync("bun", ["scripts/seed-traces.ts"], {
    cwd: REPO_ROOT_PATH,
    env: { ...process.env, RUNPHANTOM_URL: runPhantomUrl },
    stdio: "inherit",
  });
  expect(seed.status, "seed-traces.ts failed").toBe(0);
}

export async function clearRunPhantom(runPhantomUrl: string): Promise<void> {
  const res = await fetch(`${runPhantomUrl}/api/clear`, { method: "POST" });
  expect(res.ok, `POST /api/clear -> ${res.status}`).toBe(true);
}

export async function listRunPhantomRuns(runPhantomUrl: string): Promise<unknown[]> {
  const res = await fetch(`${runPhantomUrl}/api/runs?limit=5000`);
  expect(res.ok, `GET /api/runs -> ${res.status}`).toBe(true);
  return res.json() as Promise<unknown[]>;
}

export async function saveRunPhantomRun(runPhantomUrl: string, runId: string): Promise<void> {
  const detailRes = await fetch(`${runPhantomUrl}/api/runs/detail/${encodeURIComponent(runId)}`);
  expect(detailRes.ok, `GET /api/runs/detail/${runId} -> ${detailRes.status}`).toBe(true);
  const detail = await detailRes.json() as RunPhantomDetailResponse;
  const run = detail.run;

  const saveRes = await fetch(`${runPhantomUrl}/api/saved-runs/events/${encodeURIComponent(runId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: run.id,
      event_name: run.event_name ?? run.name ?? run.id.slice(0, 12),
      user_id: run.user_id ?? null,
      convo_id: run.convo_id ?? null,
      timestamp: new Date(run.started_at).toISOString(),
      user_input: "Fix the typo in README.md",
      assistant_output: null,
      saved_at: Date.now(),
      source: "local",
    }),
  });
  expect(saveRes.ok, `PUT /api/saved-runs/events/${runId} -> ${saveRes.status}`).toBe(true);
}
