export const definitionKey = "runphantom.agent.definition";
export const definitionInput = "Captured request unchanged";
export const definitionOutput = "Captured answer unchanged";
export function agentDefinition(prompt = "Private captured instructions", temperature = .123456789) {
  return { version: 1, systemPrompt: prompt, tools: [{ name: "lookup", description: "Private lookup description", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }], model: "fixture-model", providers: ["local-fixture"], runtime: { temperature, maxOutputTokens: 1024 } };
}
export function definitionTrace(slot: number, definition = agentDefinition()) {
  const id = slot.toString(16).padStart(32, "0"), spanId = "0000000000000001";
  const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const body = { resourceSpans: [{ resource: { attributes: [text("ordinary.resource", "resource unchanged")] }, scopeSpans: [{ scope: { name: "local-captured-fixture", attributes: [text("ordinary.scope", "scope unchanged")] }, spans: [{ traceId: id, spanId, name: "Captured definition run", kind: 1,
    startTimeUnixNano: "1780000000000000000", endTimeUnixNano: "1780000000100000000", status: { code: 1 }, droppedAttributesCount: 0,
    attributes: [text("runphantom.span.kind", "agent_root"), text("runphantom.input", definitionInput), text("runphantom.output", definitionOutput), text("ordinary.span", "span unchanged"), text("ai.model.id", "fixture-model"), text("ai.model.provider", "local-fixture"), { key: "ai.usage.inputTokens", value: { intValue: "2" } }, { key: "ai.usage.outputTokens", value: { intValue: "3" } }, text(definitionKey, JSON.stringify(definition))],
    events: [{ name: "Captured event", attributes: [text("ordinary.event", "event unchanged")] }], links: [{ traceId: "ffffffffffffffffffffffffffffffff", spanId: "ffffffffffffffff", attributes: [text("ordinary.link", "link unchanged")] }],
  }] }] }] };
  return { id, spanId, body };
}
