import { describe, expect, test } from "bun:test";
import { setReplayTrace, getReplayTrace, _replayTraceMapSize } from "../src/replay-map";

describe("replay stitch map", () => {
  test("is bounded, keeping the most recent entries", () => {
    for (let i = 0; i < 1500; i++) setReplayTrace(`replay-${i}`, `trace-${i}`);
    expect(_replayTraceMapSize()).toBeLessThanOrEqual(1000);
    expect(getReplayTrace("replay-1499")).toBe("trace-1499");
    expect(getReplayTrace("replay-0")).toBeUndefined();
  });

  test("re-recording a replay id refreshes it rather than duplicating", () => {
    const before = _replayTraceMapSize();
    setReplayTrace("replay-1499", "trace-corrected");
    expect(_replayTraceMapSize()).toBe(before);
    expect(getReplayTrace("replay-1499")).toBe("trace-corrected");
  });
});
