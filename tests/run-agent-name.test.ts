import { expect, test } from "bun:test";
import { deriveRunAgent, NO_AGENT_HINTS, rootAgentHints, type RootSpanForAgent } from "../src/run-agent";

const root = (name: string, attributes: Record<string, unknown> = {}, span_type = "AGENT_ROOT"): RootSpanForAgent => ({ name, span_type, attributes });
const agent = (event_name: string | null, name: string | null, finished: number, roots: RootSpanForAgent[] = []) =>
  deriveRunAgent({ event_name, name, finished, hints: roots.length ? rootAgentHints(roots) : NO_AGENT_HINTS });

test("an explicit agent attribute outranks a per-run event name", () => {
  // examples/tool-agent: the event name is the run title, gen_ai.agent.name the agent.
  const toolAgent = root("invoke_agent support-agent", { "gen_ai.agent.name": "support-agent", "runphantom.event.name": "Turn 2 · Order follow-up", "service.name": "runphantom-tool-agent" });
  expect(agent("Turn 2 · Order follow-up", "invoke_agent support-agent", 1, [toolAgent])).toBe("support-agent");
  expect(agent("Refund a damaged order", "invoke_agent support-agent", 0, [toolAgent])).toBe("support-agent");
  expect(agent(null, "TriageAgent", 1, [root("TriageAgent", { "agent.name": "billing-agent", "openinference.span.kind": "AGENT" })])).toBe("billing-agent");
  expect(agent(null, "x", 1, [root("x", { "gen_ai.agent.name": "  " }), root("y", { "gen_ai.agent.name": "second-root" })])).toBe("second-root");
  expect(agent(null, "x", 1, [root("x", { "gen_ai.agent.name": 42 })])).toBe("x");
});

test("the event name names the agent when no agent attribute does", () => {
  expect(agent("openai-chat", "openai-chat", 1)).toBe("openai-chat");
  expect(agent("replay:openai-chat", "openai-chat", 1)).toBe("openai-chat");
  expect(agent("triage_agent", "ai.generateText", 1, [root("ai.generateText", { "service.name": "web" }, "LLM_GENERATION")])).toBe("triage_agent");
  expect(agent("   ", "support-agent", 1)).toBe("support-agent");
});

test("finished agent-typed roots, then service.name, then the root span name", () => {
  expect(agent(null, "support-agent", 1, [root("support-agent", { "service.name": "orders-api" })])).toBe("support-agent");
  expect(agent(null, "invoke_agent planner", 1, [root("invoke_agent planner")])).toBe("planner");
  expect(agent(null, "invoke_agent", 1, [root("invoke_agent", { "service.name": "checkout-bot" })])).toBe("checkout-bot");
  expect(agent(null, "POST /chat", 1, [root("POST /chat", { "service.name": "checkout-bot" }, "INTERNAL")])).toBe("checkout-bot");
  expect(agent(null, "POST /chat", 0, [root("POST /chat", { "service.name": "checkout-bot" }, "INTERNAL")])).toBe("checkout-bot");
  expect(agent(null, "POST /chat", 1, [root("POST /chat", { "service.name": "unknown_service:node" }, "INTERNAL")])).toBe("POST /chat");
  expect(agent(null, "support-agent", 1)).toBe("support-agent");
});

test("a run whose root was never captured has no agent yet", () => {
  // A SIGKILLed agent exports its finished children; the stored name is then
  // the trace id prefix, not an agent.
  expect(agent(null, "c81f7f14", 0)).toBeNull();
  expect(deriveRunAgent({ event_name: null, name: "c81f7f14", finished: null, hints: NO_AGENT_HINTS })).toBeNull();
  expect(agent(null, null, 1)).toBeNull();
  expect(agent(null, "support-agent", 0, [root("support-agent")])).toBeNull();
});
