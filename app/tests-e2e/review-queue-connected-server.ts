// Ephemeral source app and actual daemon; the database is seeded once before browser actions.
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { closeDb, getDrizzleDb } from "../../src/db";
import { createServer } from "../../src/server";
import { createDataset } from "../../src/evaluations/store";

const directory = mkdtempSync(path.join(tmpdir(), "rq-connected-ui-"));
process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db");
process.env.RUNPHANTOM_PORT = "16949";
process.env.RUNPHANTOM_UI_PORT = "16950";
const db = getDrizzleDb().$client;
for (const id of ["source-a", "source-b"]) {
  db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES(?,?,1,2)").run(id, id === "source-a" ? "Checkout response" : "Refund response");
  db.query("INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,attributes,start_time_ms,end_time_ms) VALUES(?,'response','Agent response','AGENT_ROOT','OK',?,?,'{}',1,2)").run(id, `Input for ${id}`, id === "source-a" ? '{"status":"paid","score":3,"ok":true}' : '{"status":"refunded","score":4,"ok":false}');
}
createDataset("Curated checkout examples");
const { server } = await createServer(16949);
server.listen(16949, "127.0.0.1"); await once(server, "listening");
const vite = await createViteServer({ root: path.resolve(import.meta.dirname, ".."), server: { host: "127.0.0.1", port: 16950, strictPort: true, fs: { allow: [path.resolve(import.meta.dirname, "../.."), realpathSync(path.resolve(import.meta.dirname, "../../node_modules"))] } } });
await vite.listen();
const stop = async () => {
  await vite.close(); await new Promise<void>(resolve => server.close(() => resolve())); closeDb();
  rmSync(directory, { recursive: true, force: true }); process.exit(0);
};
process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
