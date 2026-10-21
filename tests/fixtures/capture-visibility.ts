export const captureInput = "Inspect captured retrieval evidence";
export const captureOutput = "Authoritative captured answer";
export const filterSecret = "synthetic-filter-credential-F16";
export const captureAttributes = (input: Record<string, string | number | boolean>) => Object.entries(input).map(([key, item]) => ({ key, value: typeof item === "number" ? Number.isInteger(item) ? { intValue: String(item) } : { doubleValue: item } : typeof item === "boolean" ? { boolValue: item } : { stringValue: item } }));
export function chunk(sequence: number, text: string) {
  return { name: "runphantom.stream.chunk", timeUnixNano: String(1770000000100000000n + BigInt(sequence)), droppedAttributesCount: 0,
    attributes: captureAttributes({ "runphantom.stream.sequence": sequence, "runphantom.stream.text": text }) };
}
export function terminal(state = "completed", count?: number) {
  return { name: `runphantom.stream.${state}`, timeUnixNano: "1770000001000000000", droppedAttributesCount: 0,
    attributes: captureAttributes(count === undefined ? {} : { "runphantom.stream.chunk_count": count }) };
}
export function captureTrace(index = 1601) {
  const id = index.toString(16).padStart(32, "0");
  const span = (offset: number, name: string, attrs: Record<string, string | number | boolean>, events: ReturnType<typeof chunk>[] = []) => ({
    traceId: id, spanId: (index * 10 + offset).toString(16).padStart(16, "0"), name,
    startTimeUnixNano: String(1770000000000000000n + BigInt(offset * 1000000)), endTimeUnixNano: "1770000002000000000",
    status: { code: 1 }, droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0, attributes: captureAttributes(attrs), events,
  });
  const retrieval = span(1, "Captured vector search", { "db.system.name": "qdrant", "db.operation.name": "SEARCH", "db.collection.name": "manuals",
    "db.vector.query.top_k": 3, "db.n_results": 0, "db.query.summary": "SEARCH manuals limit=3", "db.filter": JSON.stringify({ api_key: filterSecret, city: "Paris" }) });
  const embedding = span(2, "Captured embedding", { "gen_ai.operation.name": "embeddings", "gen_ai.embeddings.dimension.count": 1536, "gen_ai.request.model": "fixture-embedding", "gen_ai.input.messages": "Captured embedding input" });
  const llm = span(3, "Captured streaming answer", { "gen_ai.operation.name": "chat", "gen_ai.request.stream": true, "gen_ai.response.time_to_first_chunk": 0,
    "gen_ai.usage.cache_read.input_tokens": 0, "gen_ai.usage.reasoning_tokens": 2, "ai.prompt.messages": JSON.stringify([{ role: "user", content: captureInput }]), "ai.response.text": captureOutput,
    "ai.usage.inputTokens": 7, "ai.usage.outputTokens": 3 }, [chunk(1, "world"), chunk(0, "Hello "), terminal("completed", 2)]);
  const cancelled = span(4, "Cancelled stream", { "gen_ai.operation.name": "chat", "gen_ai.request.stream": true }, [chunk(0, "Partial evidence"), terminal("cancelled")]);
  return { id, retrieval, embedding, llm, cancelled, body: { resourceSpans: [{ scopeSpans: [{ scope: { name: "capture-fixture", version: "1" }, spans: [retrieval, embedding, llm, cancelled] }] }] } };
}
