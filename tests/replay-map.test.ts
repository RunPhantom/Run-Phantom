import { expect, test } from "bun:test";
import { _replayTraceMapSize, getReplayTrace, setReplayTrace } from "../src/replay-map";

test("refreshing a replay identity changes eviction order without growing the 1,000-entry cache", () => {
  for (let index = 0; index < 1000; index++) setReplayTrace(`capacity-${index}`, `trace-${index}`);
  expect(_replayTraceMapSize()).toBe(1000);

  setReplayTrace("capacity-0", "trace-corrected");
  setReplayTrace("capacity-next", "trace-next");
  expect(_replayTraceMapSize()).toBe(1000);
  expect(getReplayTrace("capacity-0")).toBe("trace-corrected");
  expect(getReplayTrace("capacity-1")).toBeUndefined();
  expect(getReplayTrace("capacity-next")).toBe("trace-next");

  for (let index = 0; index < 1001; index++) setReplayTrace(`replacement-${index}`, `replacement-trace-${index}`);
  expect(_replayTraceMapSize()).toBe(1000);
  expect(getReplayTrace("capacity-0")).toBeUndefined();
  expect(getReplayTrace("replacement-0")).toBeUndefined();
  expect(getReplayTrace("replacement-1000")).toBe("replacement-trace-1000");
});
