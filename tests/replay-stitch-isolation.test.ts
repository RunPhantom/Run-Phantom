import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

// realpath because macOS reports a symlinked tmpdir; a bare "/private/tmp" literal
// is a macOS-ism that cannot be created on Linux CI.
const DB = path.join(fs.realpathSync(os.tmpdir()), "rp-e2e", "replay-stitch.db");
const { upsertRun, insertSpan, findRecentRunByEventName, closeDb } = await import("../src/db");

function withFixtureDb(fn: () => void): void {
  const original = process.env.RUNPHANTOM_DB_PATH;
  process.env.RUNPHANTOM_DB_PATH = DB;
  try { fn(); }
  finally {
    if (original === undefined) delete process.env.RUNPHANTOM_DB_PATH;
    else process.env.RUNPHANTOM_DB_PATH = original;
  }
}

afterAll(() => { closeDb(); });

const NOW = 1_700_000_000_000;
const placeholderMeta = (src: string) =>
  JSON.stringify({ replay: { sourceRunId: src, mode: "local", model: null, overrides: {} } });

describe("replay fallback stitcher", () => {
  beforeAll(() => withFixtureDb(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(DB + suffix); } catch { /* fresh run */ }
    }
    // Two concurrent replays of the same source: both write a placeholder under
    // the same event name. Neither may be adopted by the other.
    upsertRun({ id: "placeholder-A", name: "Replay of agent (#1)", event_name: "replay:agent",
      started_at: NOW + 10, last_updated_at: NOW + 10, metadata: placeholderMeta("src-1") });
    upsertRun({ id: "placeholder-B", name: "Replay of agent (#2)", event_name: "replay:agent",
      started_at: NOW + 20, last_updated_at: NOW + 20, metadata: placeholderMeta("src-1") });
    // The run the agent actually shipped: same event name, real spans, no replay metadata.
    upsertRun({ id: "agent-trace", name: "agent", event_name: "replay:agent",
      started_at: NOW + 30, last_updated_at: NOW + 30 });
    insertSpan({ id: "s1", run_id: "agent-trace", name: "root",
      start_time_ms: NOW + 30, end_time_ms: NOW + 40, duration_ms: 10 });
    findRecentRunByEventName("replay:agent", NOW, "placeholder-A");
  }));

  test("does not adopt another in-flight replay's placeholder", () => {
    const hit = findRecentRunByEventName("replay:agent", NOW, "placeholder-A");
    expect(hit?.id).toBe("agent-trace");
  });

  test("is symmetric — B does not adopt A either", () => {
    const hit = findRecentRunByEventName("replay:agent", NOW, "placeholder-B");
    expect(hit?.id).toBe("agent-trace");
  });

  test("returns null when only placeholders exist, rather than corrupting one", () => {
    withFixtureDb(() => {
      upsertRun({ id: "placeholder-C", name: "Replay of solo (#1)", event_name: "replay:solo",
        started_at: NOW + 50, last_updated_at: NOW + 50, metadata: placeholderMeta("src-2") });
    });
    expect(findRecentRunByEventName("replay:solo", NOW, "placeholder-D")).toBeNull();
  });

  test("still ignores runs that predate the window", () => {
    expect(findRecentRunByEventName("replay:agent", NOW + 10_000, undefined)).toBeNull();
  });
});
