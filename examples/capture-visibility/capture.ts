// Local-only finite application capture. No instrumentation dependency or provider call.
const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:5947");
if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("Supply a local Run Phantom endpoint");
const id = crypto.randomUUID().replaceAll("-", "");
const start = BigInt(Date.now()) * 1_000_000n;
const attributes = (items: Record<string, string | number | boolean>) => Object.entries(items).map(([key, value]) => ({ key,
  value: typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : { intValue: String(value) } }));
const event = (name: string, items: Record<string, string | number>) => ({ name, timeUnixNano: String(start), droppedAttributesCount: 0, attributes: attributes(items) });
const span = (number: number, name: string, items: Record<string, string | number | boolean>, events: ReturnType<typeof event>[] = []) => ({
  traceId: id, spanId: number.toString(16).padStart(16, "0"), name, startTimeUnixNano: String(start + BigInt(number)), endTimeUnixNano: String(start + 1_000_000n),
  status: { code: 1 }, droppedAttributesCount: 0, droppedEventsCount: 0, attributes: attributes(items), events,
});
const spans = [
  span(1, "Local captured retrieval", { "db.system.name": "qdrant", "db.operation.name": "SEARCH", "db.collection.name": "manuals", "db.vector.query.top_k": 3, "db.n_results": 0 }),
  span(2, "Local captured embedding", { "gen_ai.operation.name": "embeddings", "gen_ai.embeddings.dimension.count": 1536 }),
  span(3, "Local captured stream", { "gen_ai.operation.name": "chat", "gen_ai.request.stream": true, "ai.prompt.messages": JSON.stringify([{ role: "user", content: "Inspect local captured evidence" }]), "ai.response.text": "Authoritative local answer" },
    [event("runphantom.stream.chunk", { "runphantom.stream.sequence": 0, "runphantom.stream.text": "Observed text" }), event("runphantom.stream.completed", { "runphantom.stream.chunk_count": 1 })]),
];
const response = await fetch(new URL("/v1/traces", endpoint), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: "local-capture-example", version: "1" }, spans }] }] }) });
if (!response.ok) throw new Error(`Local capture rejected: ${response.status}`);
console.log(new URL(`/runs/${id}`, endpoint).href);
