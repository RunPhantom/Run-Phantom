import { describe, expect, test } from "bun:test";
import { isActive, runStatus } from "../app/src/utils/helpers";

// A replay placeholder is a span-less run row whose only record of what happened
// is the `replay.error` the daemon writes into its metadata (src/replay.ts
// recordPlaceholderError). It has no finish flag and no ERROR spans, so every
// span-derived signal says "still running" and then "finished cleanly".
function placeholder(error?: { code: string; message: string }) {
  const now = Date.now();
  return {
    last_updated_at: now,
    finished: null,
    live_event_count: 0,
    metadata: JSON.stringify({
      replay: {
        sourceRunId: "b1000000000000000000000000000001",
        mode: "local",
        model: null,
        overrides: { model: false, systemPrompt: false },
        ...(error ? { error: { ...error, at: now } } : {}),
      },
    }),
  };
}

describe("replay placeholder status", () => {
  const failed = placeholder({ code: "agent_http_error", message: "Agent endpoint returned HTTP 503." });
  const cancelled = placeholder({ code: "replay_cancelled", message: "Replay was cancelled because the client disconnected." });

  test("a failed placeholder is never live and reads failed", () => {
    expect(isActive(failed)).toBe(false);
    expect(runStatus(failed).status).toBe("failed");
  });

  test("a cancelled placeholder is never live and reads cancelled", () => {
    expect(isActive(cancelled)).toBe(false);
    expect(runStatus(cancelled).status).toBe("cancelled");
  });

  test("the recorded failure outlasts the recency window", () => {
    const stale = { ...failed, last_updated_at: Date.now() - 60_000 };
    expect(runStatus(stale).status).toBe("failed");
    expect(runStatus({ ...cancelled, last_updated_at: Date.now() - 60_000 }).status).toBe("cancelled");
  });

  test("an in-flight placeholder without an error is still live", () => {
    const pending = placeholder();
    expect(isActive(pending)).toBe(true);
    expect(runStatus(pending).status).toBe("live");
  });

  test("a quiet placeholder that never recorded spans or an end is unknown, not complete", () => {
    expect(runStatus({ ...placeholder(), last_updated_at: Date.now() - 60_000, span_count: 0 }).status).toBe("unknown");
  });

  test("ordinary runs keep their span-derived status", () => {
    const done = { last_updated_at: Date.now() - 60_000, finished: 1, metadata: null };
    expect(runStatus(done).status).toBe("complete");
    expect(runStatus({ ...done, error_count: 2, root_failed: true }).status).toBe("failed");
    expect(runStatus({ ...done, last_updated_at: Date.now(), finished: null }).status).toBe("live");
    expect(runStatus({ ...done, metadata: "not json" }).status).toBe("complete");
  });
});
