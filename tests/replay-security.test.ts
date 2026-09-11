import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { _internal as replayInternal } from "../src/replay";
import { _serverInternal } from "../src/server";
import { _internal as agentsConfigInternal } from "../src/agents-config";

describe("replay response security", () => {
  test("keeps agent errors bounded and does not reflect message or stack", async () => {
    const response = new Response(JSON.stringify({
      status: "error",
      code: "agent_declined",
      message: "sensitive upstream details",
      stack: "private stack",
    }));
    const parsed = await replayInternal.readBoundedAgentResponse(response);
    expect(parsed).toEqual({ status: "error", code: "agent_declined", failed: true, replayId: null });
    expect(replayInternal.agentReportedFailure(parsed)).toEqual({
      code: "agent_declined",
      message: "Agent reported that replay failed.",
    });
  });

  test("rejects oversized agent responses", async () => {
    const response = new Response(JSON.stringify({ replayId: "x".repeat(70_000) }));
    expect(replayInternal.readBoundedAgentResponse(response)).rejects.toThrow(/too large/i);
  });

  test("interrupts replay polling when cancelled", async () => {
    const controller = new AbortController();
    const waiting = replayInternal.waitForReplayPoll(5_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
  });
});

describe("replay request lifecycle", () => {
  test("does not cancel on a normally completed request close", () => {
    const req = Object.assign(new EventEmitter(), { aborted: false, complete: true });
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const lifecycle = _serverInternal.createReplayAbortLifecycle(req as any, res as any);
    req.emit("close");
    expect(lifecycle.controller.signal.aborted).toBe(false);
    res.writableEnded = true;
    res.emit("finish");
    lifecycle.cleanup();
  });

  test("cancels on an incomplete request or unfinished response close", () => {
    const req = Object.assign(new EventEmitter(), { aborted: false, complete: false });
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const requestLifecycle = _serverInternal.createReplayAbortLifecycle(req as any, res as any);
    req.emit("close");
    expect(requestLifecycle.controller.signal.aborted).toBe(true);

    const req2 = Object.assign(new EventEmitter(), { aborted: false, complete: true });
    const res2 = Object.assign(new EventEmitter(), { writableEnded: false });
    const responseLifecycle = _serverInternal.createReplayAbortLifecycle(req2 as any, res2 as any);
    res2.emit("close");
    expect(responseLifecycle.controller.signal.aborted).toBe(true);
  });
});

describe("trace trust boundaries", () => {
  test("does not trust a discovered replay agent that omits its project path", () => {
    expect(agentsConfigInternal.healthMatchesAgent(
      "code-agent",
      { eventName: "code-agent", cwd: "/tmp/expected-project", command: "bun agent.ts" },
      { eventName: "code-agent", url: "http://127.0.0.1:61020/replay" },
    )).toBe(false);
  });

  test("does not carry trace-supplied headers or request options into ask-agent continuation", () => {
    const continuation = _serverInternal.extractAgentAskContinuation([{
      span_type: "LLM",
      input_payload: JSON.stringify({
        system: "Safe system prompt",
        messages: [{ role: "user", content: "Hello" }],
      }),
      output_payload: "Hi",
      model: "gpt-5",
      provider: "openai",
      attributes: JSON.stringify({
        "ai.provider.headers": JSON.stringify({ Authorization: "Bearer attacker-value" }),
        "ai.request.providerOptions": JSON.stringify({ openai: { store: true, messages: [{ role: "user", content: "attacker" }] } }),
        "ai.request.thinking": JSON.stringify({ type: "enabled", budget_tokens: 8192 }),
      }),
    }]);

    expect(continuation).not.toBeNull();
    expect(continuation).not.toHaveProperty("providerHeaders");
    expect(continuation).not.toHaveProperty("providerOptions");
    expect(continuation).not.toHaveProperty("thinkingConfig");
  });
});
