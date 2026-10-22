import { once } from "node:events";
import WebSocket from "ws";
import { closeDb, getLiveEvents } from "../../src/db";
import { createServer } from "../../src/server";

// A separate owned process contains the actual demo's remaining scheduled timers.
const { server } = await createServer(0);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
if (process.argv.includes("history")) {
  const id = "00000000000000000000000000000001";
  const imported = await fetch(url + "/api/import-run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run: { id, name: "earlier database", started_at: 1, last_updated_at: 2 },
      spans: [{ id: "0000000000000001", run_id: id, name: "earlier span", span_type: "TOOL_CALL", status: "OK", start_time_ms: 1, end_time_ms: 2, duration_ms: 1 }],
      liveEvents: [{ type: "reasoning", content: "historical collision|", timestamp: 10 }],
    }),
  });
  if (!imported.ok) throw new Error(`Actual history import failed: ${imported.status}`);
  const detail = await fetch(url + `/api/runs/detail/${id}`);
  if (!detail.ok) throw new Error(`Actual history read failed: ${detail.status}`);
  console.log("HISTORY_IDENTITY " + JSON.stringify(await detail.json()));
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeDb();
  process.exit(0);
}
const socket = new WebSocket(url.replace("http:", "ws:") + "/ws");
const live = new Promise<{ traceId: string; persistedId?: number; content: string }>(resolve => {
  socket.on("message", message => {
    const frame = JSON.parse(message.toString());
    if (frame.event === "live") resolve(frame.data);
  });
});
await once(socket, "open");
const result = await fetch(url + "/api/demo-traces/replay", { method: "POST" });
if (!result.ok) throw new Error(`Actual demo start failed: ${result.status}`);
const frame = await live;
const rows = getLiveEvents(frame.traceId);
const row = rows.find(event => typeof frame.persistedId === "number" ? event.id === frame.persistedId : event.content === frame.content)!;
console.log("DEMO_IDENTITY " + JSON.stringify({ persistedId: frame.persistedId, rowId: row.id, content: frame.content, rowContent: row.content }));
const closed = once(socket, "close");
socket.terminate();
await closed;
server.closeAllConnections();
if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
closeDb();
// Fixture-only terminal: no outstanding demo timer can mutate the next test's DB.
process.exit(0);
