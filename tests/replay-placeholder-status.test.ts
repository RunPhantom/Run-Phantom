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
    expect(runStatus(failed, 0)).toBe("failed");
  });

  test("a cancelled placeholder is never live and reads cancelled", () => {
    expect(isActive(cancelled)).toBe(false);
    expect(runStatus(cancelled, 0)).toBe("cancelled");
  });

  test("the recorded failure outlasts the recency window", () => {
    const stale = { ...failed, last_updated_at: Date.now() - 60_000 };
    expect(runStatus(stale, 0)).toBe("failed");
    expect(runStatus({ ...cancelled, last_updated_at: Date.now() - 60_000 }, 0)).toBe("cancelled");
  });

  test("an in-flight placeholder without an error is still live", () => {
    const pending = placeholder();
    expect(isActive(pending)).toBe(true);
    expect(runStatus(pending, 0)).toBe("live");
    expect(runStatus({ ...pending, last_updated_at: Date.now() - 60_000 }, 0)).toBe("complete");
  });

  test("ordinary runs keep their span-derived status", () => {
    const done = { last_updated_at: Date.now() - 60_000, finished: 1, metadata: null };
    expect(runStatus(done, 0)).toBe("complete");
    expect(runStatus(done, 2)).toBe("failed");
    expect(runStatus({ ...done, last_updated_at: Date.now(), finished: null }, 0)).toBe("live");
    expect(runStatus({ ...done, metadata: "not json" }, 0)).toBe("complete");
  });
});
