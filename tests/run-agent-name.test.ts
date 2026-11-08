import { expect, test } from "bun:test";
import { runAgentName } from "../app/src/utils/helpers";

test("runs without an event name are grouped by their captured root span", () => {
  // An openinference-instrumentation-openai agent sets no runphantom.event.name;
  // its run is named after the AGENT root span.
  expect(runAgentName({ event_name: null, name: "support-agent", finished: 1 })).toBe("support-agent");
  expect(runAgentName({ event_name: "openai-chat", name: "openai-chat", finished: 1 })).toBe("openai-chat");
  expect(runAgentName({ event_name: "replay:openai-chat", name: "openai-chat", finished: 1 })).toBe("openai-chat");
  expect(runAgentName({ event_name: "   ", name: "support-agent", finished: 1 })).toBe("support-agent");
});

test("a run whose root was never captured has no agent yet", () => {
  // A SIGKILLed agent exports its finished children; the stored name is then
  // the trace id prefix, not an agent.
  expect(runAgentName({ event_name: null, name: "c81f7f14", finished: 0 })).toBeNull();
  expect(runAgentName({ event_name: null, name: "c81f7f14", finished: null })).toBeNull();
  expect(runAgentName({ event_name: null, name: null, finished: 1 })).toBeNull();
});
