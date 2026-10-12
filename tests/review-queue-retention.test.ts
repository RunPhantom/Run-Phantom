import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { closeDb, getDrizzleDb, deleteRun } from "../src/db";
import { createReviewQueueRouter } from "../src/review-queues/router";
import { ReviewDrafts } from "../app/src/components/review-queues/drafts";
import { ReviewRequestError } from "../app/src/components/review-queues/client";
import type { ReviewDraft, ReviewItem, ReviewMutation, ReviewQueue } from "../src/review-queues/protocol";

let directory: string, priorDb: string | undefined, server: http.Server, base: string;
beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "rq-retention-unactivated-")); priorDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "fixture.db"); getDrizzleDb();
  const app = express(); app.use("/api/review-queues",createReviewQueueRouter()); server = http.createServer(app);
  server.listen(0,"127.0.0.1"); await once(server,"listening"); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/review-queues`;
});
afterAll(async () => {
  await new Promise<void>(resolve=>server.close(()=>resolve())); closeDb();
  if (priorDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = priorDb;
  rmSync(directory,{ recursive:true,force:true });
});
async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(base+url,{ method,headers:body === undefined ? {} : { "Content-Type":"application/json" },body:body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new ReviewRequestError(value.error.message,response.status,value.error.code); return value as T;
}
const changed = (item: ReviewItem, value: string): ReviewDraft => ({ ...item.draft,target:{ expectedOutput:value } });
function sources(value: unknown, found = new Set<string>(), seen = new Set<unknown>()): Set<string> {
  if (typeof value !== "object" || value === null || seen.has(value)) return found;
  seen.add(value); const row = value as Record<string,unknown>;
  if (row.version === 1 && row.sourceSnapshotVersion === 1 && typeof row.runId === "string" && Object.hasOwn(row,"output")) found.add(row.runId);
  for (const child of Object.values(row)) sources(child,found,seen); return found;
}

describe("source-free retained drafts against native SQLite and HTTP", () => {
  test("six default-debounce conflicts plus a disjoint window retain at most five full sources", async () => {
    const queue = await call<ReviewQueue>("","POST",{ name:"Source retention bound" }), db = getDrizzleDb().$client;
    const all: ReviewItem[] = [];
    for (let n = 0; n < 9; n++) {
      const runId = `retention-source-${n}`;
      db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES(?,?,1,2)").run(runId,`Source ${n}`);
      db.query("INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,attributes,start_time_ms,end_time_ms) VALUES(?,'response','Response','AGENT_ROOT','OK','Input',?,'{}',1,2)").run(runId,`FROZEN_SOURCE_BODY_${n}_${"x".repeat(4096)}`);
      all.push(await call<ReviewItem>(`/${queue.id}/items`,"POST",{ runId }));
    }
    const api = {
      mutate:(queueId: string,id: string,kind:"save"|"approve"|"reopen",request:ReviewMutation)=>call<ReviewItem>(`/${queueId}/items/${id}${kind === "save" ? "" : `/${kind}`}`,kind === "save" ? "PUT" : "POST",request),
      window:(queueId:string,id:string)=>call<ReviewItem[]>(`/${queueId}/window?centerId=${id}`),
    };
    const state = new ReviewDrafts(api); // Exercise the production 600ms debounce.
    try {
      for (const item of all.slice(0,6)) state.edit(item,changed(item,`Local target ${item.ordinal}`));
      expect(sources([...state.entries.values()]).size).toBe(0);
      expect(Object.keys(state.entries.get(all[0].id)!.server).sort()).toEqual(["id","queueId","revision","state"]);
      for (const item of all.slice(0,6)) await api.mutate(queue.id,item.id,"save",{ expectedRevision:item.revision,mutationId:`independent-${item.ordinal}`,draft:changed(item,"Other writer") });
      const deadline = Date.now()+3000;
      while ([...state.entries.values()].some(entry=>!entry.conflict || entry.busy) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
      expect(state.dirtyCount).toBe(6); expect([...state.entries.values()].every(entry=>entry.conflict && !entry.busy)).toBe(true);
      const displayed = await api.window(queue.id,all[8].id); displayed.forEach(item=>state.hydrate(item));
      expect(displayed).toHaveLength(3);
      const retained = [...state.entries.values()];
      const distinctFullSources = sources([displayed,retained]);
      console.log(JSON.stringify({ defaultDebounceMs:600,retainedDrafts:state.dirtyCount,displaySources:displayed.length,distinctFullSources:distinctFullSources.size }));
      expect(distinctFullSources.size).toBeLessThanOrEqual(5);
      expect(sources(retained).size).toBe(0); expect(JSON.stringify(retained)).not.toContain("FROZEN_SOURCE_BODY_");
      for (const item of all.slice(0,6)) expect(state.entries.get(item.id)!.draft.target.expectedOutput).toBe(`Local target ${item.ordinal}`);
      const first = all[0], latest = (await api.window(queue.id,first.id)).find(item=>item.id===first.id)!;
      state.reapply(first.id,latest); await state.save(first.id);
      expect((await api.window(queue.id,first.id)).find(item=>item.id===first.id)!.draft.target.expectedOutput).toBe(`Local target ${first.ordinal}`);
      expect(state.dirtyCount).toBe(5); expect(sources([...state.entries.values()]).size).toBe(0);
      const deleted = all[1]; deleteRun(deleted.source.runId);
      await state.retry(deleted.id); expect(state.entries.get(deleted.id)!.draft.target.expectedOutput).toBe(`Local target ${deleted.ordinal}`);
      let deletionError = ""; try { await api.window(queue.id,deleted.id); } catch (failure) { deletionError = (failure as Error).message; }
      expect(deletionError).toContain("not found");
      state.discard(deleted.id); expect(state.dirtyCount).toBe(4);
      state.edit(all[8],changed(all[8],"Actual approval target"));
      const approved = await state.approve(all[8]); expect(approved.state).toBe("approved"); expect(approved.source).toEqual(all[8].source);
      const reopened = await state.reopen(approved); expect(reopened.state).toBe("draft"); expect(reopened.source).toEqual(all[8].source);
      expect(sources([...state.entries.values()]).size).toBe(0);
    } finally { state.dispose(); }
  });
});
