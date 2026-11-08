import { expect, test } from "bun:test";
import { buildReplayModelOptions } from "../app/src/utils/replay-models";

test("a registered agent's declared models replace the generic fallbacks", () => {
  // agents.yaml and GET /health for a real support agent declared these two.
  expect(buildReplayModelOptions({ runModel: "gpt-6.1-terra", selectedModel: "gpt-6.1-terra", agentModels: ["gpt-6.1-terra", "claude-sonnet-5-5"], anthropicModels: ["claude-haiku-4-5-20251001"] }))
    .toEqual(["gpt-6.1-terra", "claude-sonnet-5-5"]);
});

test("the captured model stays available even when the agent does not list it", () => {
  expect(buildReplayModelOptions({ runModel: "gpt-5.4", agentModels: ["claude-sonnet-5-5"] })).toEqual(["gpt-5.4", "claude-sonnet-5-5"]);
});

test("without declared models the provider list and defaults remain", () => {
  const options = buildReplayModelOptions({ runModel: "gpt-6.1-terra", anthropicModels: ["claude-sonnet-5-5"] });
  expect(options.slice(0, 2)).toEqual(["gpt-6.1-terra", "claude-sonnet-5-5"]);
  expect(options).toContain("claude-sonnet-4-6");
  expect(buildReplayModelOptions({ runModel: "gpt-6.1-terra", agentModels: [42, "", "  "] })).toContain("claude-sonnet-4-6");
});
