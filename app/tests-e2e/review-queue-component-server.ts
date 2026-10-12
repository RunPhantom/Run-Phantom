// Ephemeral same-DB SQLite/HTTP/browser fixture. This does not activate a central migration.
import express from "express";
import http from "node:http";
import { mkdtempSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { getDrizzleDb, getRuns, closeDb } from "../../src/db";
import { createLocalOriginGuard } from "../../src/local-origin-guard";
import { createReviewQueueRouter } from "../../src/review-queues/router";
import { createEvaluationRouter } from "../../src/evaluations/router";
import { EvaluationService } from "../../src/evaluations/service";
import { createDataset } from "../../src/evaluations/store";
import { REVIEW_QUEUE_FIXTURE_DDL } from "../../tests/review-queue-fixture-ddl";
const directory = mkdtempSync(path.join(tmpdir(), "rq-browser-unactivated-"));
process.env.RUNPHANTOM_DB_PATH = path.join(directory, "fixture.db");
const db = getDrizzleDb().$client; db.exec(REVIEW_QUEUE_FIXTURE_DDL);
for (const id of ["source-a", "source-b"]) {
  db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES(?,?,1,2)").run(id, id === "source-a" ? "Checkout response" : "Refund response");
  db.query("INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,attributes,start_time_ms,end_time_ms) VALUES(?,'response','Agent response','AGENT_ROOT','OK',?,?,'{}',1,2)").run(id, `Input for ${id}`, id === "source-a" ? '{"status":"paid","score":3,"ok":true}' : '{"status":"refunded","score":4,"ok":false}');
}
createDataset("Curated checkout examples");
const app = express(), server = http.createServer(app), port = 16947;
app.get("/fixture-health", (_req,res) => res.json({ fixture: "unactivated", database: "native-sqlite" }));
app.use("/api", createLocalOriginGuard({ daemonPort: port }));
app.use((req,res,next) => {
  if (req.headers["x-review-fixture-delay-ack"] === "1") { const json = res.json.bind(res); res.json = body => { setTimeout(() => json(body), 900); return res; }; }
  next();
});
app.use("/api/review-queues", createReviewQueueRouter());
app.get("/api/runs", (_req,res) => res.json(getRuns(50)));
app.get("/api/runs/search", (req,res) => { const q = typeof req.query.q === "string" ? req.query.q : ""; res.json({ runs:getRuns(50).filter(run => !q || (run.name ?? run.id).includes(q)),nextCursor:null,hasMore:false,elapsedMs:0 }); });
app.use(express.json({ limit:"2mb" }));
app.use("/api/evaluations",createEvaluationRouter(new EvaluationService()));
const vite = await createViteServer({ root:path.resolve(import.meta.dirname,".."), server:{ middlewareMode:true,fs:{ allow:[path.resolve(import.meta.dirname,"../.."),realpathSync(path.resolve(import.meta.dirname,"../../node_modules"))] } }, appType:"mpa" });
app.get("/evaluations", async (req,res,next) => { try { const html = readFileSync(path.resolve(import.meta.dirname,"review-queue-component.html"),"utf8"); res.type("html").send(await vite.transformIndexHtml(req.originalUrl,html)); } catch (failure) { next(failure); } });
app.use(vite.middlewares); server.listen(port,"127.0.0.1");
const stop = async () => { await vite.close(); server.close(); closeDb(); rmSync(directory,{ recursive:true,force:true }); process.exit(0); };
process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
