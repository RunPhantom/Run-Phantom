import { readFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { recordingStoreFixture } from "../helpers/recording-store-fixture";
import type { RecordingAdmission } from "../../src/verification/recording";
import { RecordingInputError } from "../../src/verification/recording-types";

const assets = process.env.RUNPHANTOM_RECORDING_FIXTURE_ASSETS;
const hostToken = process.env.RUNPHANTOM_RECORDING_FIXTURE_TOKEN;
if (!assets || !hostToken || !/^[a-f0-9]{64}$/.test(hostToken)) throw new Error("Explicit private fixture resources required");
const fixture = recordingStoreFixture(), store = fixture.store();
const leases = new Map<string, string>();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 128 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    const host = request.headers.get("x-recording-fixture-token") === hostToken;
    const sameOrigin = request.headers.get("origin") === url.origin;
    try {
      if (url.pathname === "/fixture/receipt" && request.method === "GET" && host) return Response.json({
        sqlite: fixture.db.query("SELECT sqlite_version() version").get(), journal: fixture.db.query("PRAGMA journal_mode").get(), synchronous: fixture.db.query("PRAGMA synchronous").get(), foreignKeys: fixture.db.query("PRAGMA foreign_keys").get(),
        population: fixture.db.query("SELECT count(*) lifetimes,sum(CASE WHEN status<>'deleted' THEN 1 ELSE 0 END) retained FROM browser_recordings").get(),
        batches: fixture.db.query("SELECT count(*) n,coalesce(sum(length(cast(data AS BLOB))),0) bytes FROM browser_recording_batches").get(),
      });
      if (url.pathname === "/fixture/admit" && request.method === "POST") {
        if (!host) return new Response("Private fixture authority required", { status: 403 });
        const lease = store.admit(await request.json() as RecordingAdmission); leases.set(lease.summary.id, lease.token); return Response.json(lease);
      }
      const match = /^\/fixture\/recordings\/([a-f0-9-]{36})(?:\/(publish|stop|delete|export))?$/.exec(url.pathname);
      if (match) {
        const id = match[1], action = match[2];
        if (request.method === "GET") {
          const evidence = store.batches(id);
          if (action === "export") return new Response(JSON.stringify({ format: "runphantom-masked-layout/v1", ...evidence }), { headers: { "content-type": "application/json", "content-disposition": "attachment; filename=runphantom-masked-recording.json", "cache-control": "no-store" } });
          if (!action) return Response.json(evidence, { headers: { "cache-control": "no-store" } });
        }
        if (request.method === "POST" && (host || sameOrigin)) {
          const lease = leases.get(id); if (!lease) return new Response("Lease unavailable", { status: 409 });
          if (action === "publish" && host) return Response.json(store.publish(id, lease, await request.text()));
          if (action === "stop") return Response.json({ stopped: store.finish(id, lease, "complete", "none", Date.now()) });
          if (action === "delete") { store.delete(id); return Response.json({ deleted: true }); }
        }
        return new Response("Fixture request refused", { status: 403 });
      }
      if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Run Phantom masked recording component</title><link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/recording-player-fixture.css"><div id="root"></div><script type="module" src="/assets/recording-player-fixture.js"></script></html>', { headers: { "content-type": "text/html" } });
      if (url.pathname === "/fonts/syne-variable.ttf") return new Response(readFileSync(resolve("app/public/fonts/syne-variable.ttf")), { headers: { "content-type": "font/ttf" } });
      if (url.pathname.startsWith("/assets/") && basename(url.pathname) === url.pathname.slice(8) && /^[a-zA-Z0-9_.-]+$/.test(basename(url.pathname))) {
        const file = join(assets, basename(url.pathname)); if (!existsSync(file)) return new Response("Fixture resource missing", { status: 404 });
        return new Response(readFileSync(file), { headers: { "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "font/woff2" } });
      }
      return new Response("Fixture not found", { status: 404 });
    } catch (cause) { return Response.json({ error: cause instanceof RecordingInputError ? cause.message : "Private recording fixture unavailable" }, { status: cause instanceof RecordingInputError ? cause.status : 500 }); }
  },
});
process.stdout.write(JSON.stringify({ origin: `http://127.0.0.1:${server.port}`, pid: process.pid, profile: fixture.profile, database: fixture.path }) + "\n");
let closing = false;
process.on("SIGTERM", () => { if (closing) return; closing = true; void server.stop(true).then(() => { fixture.close(); process.exit(0); }); });
