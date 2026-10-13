import { beforeAll, afterAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createTeamServer } from "../src/team/server";
import type { SessionResponse } from "../src/team/protocol";
interface Identity { cookie: string; csrf: string; accountId: string }
let profile: string, url: string, handle: Awaited<ReturnType<typeof createTeamServer>>, project: string;
let owner: Identity, editor: Identity, viewer: Identity;
async function call(method: string, path: string, body?: unknown, identity?: Identity) {
  const response = await fetch(url + "/api/team" + path, { method, headers: { ...(method === "GET" ? {} : { Origin: url }), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(identity ? { Cookie: identity.cookie, "X-RunPhantom-CSRF": identity.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = response.status === 204 ? undefined : await response.json();
  return { response, data };
}
function identity(response: Response, session: SessionResponse): Identity { if (!session.authenticated) throw new Error("Actual authentication failed"); const cookie=response.headers.get("set-cookie");if(!cookie)throw new Error("Actual session cookie absent");return { cookie: cookie.split(";")[0], csrf: session.csrfToken, accountId: session.user.id }; }
beforeAll(async () => {
  profile=mkdtempSync(join(realpathSync(tmpdir()),"f30-real-team-http-red-"));
  const socket=createServer(); await new Promise<void>(resolve=>socket.listen(0,"127.0.0.1",resolve));const address=socket.address();if(!address||typeof address==='string')throw new Error("Port unavailable");const port=address.port;await new Promise<void>(resolve=>socket.close(()=>resolve()));url=`http://127.0.0.1:${port}`;
  const bootstrapCode=randomBytes(32).toString("base64url");
  handle=await createTeamServer({ port,bindHost:"127.0.0.1",publicOrigin:url,trustedProxyIps:[],dataDir:join(profile,"team"),bootstrapCode },{uiDir:profile});
  await new Promise<void>(resolve=>handle.server.listen(port,"127.0.0.1",resolve));
  const setup=await call("POST","/setup",{setupCode:bootstrapCode,email:"owner@example.test",password:"actual owner password"});expect(setup.response.status).toBe(201);owner=identity(setup.response,setup.data);
  const created=await call("POST","/projects",{name:"Project review native RED"},owner);expect(created.response.status).toBe(201);project=created.data.id;
  for (const role of ['editor','viewer'] as const) {
    const invited=await call("POST",`/projects/${project}/invites`,{email:role+"@example.test",role},owner);expect(invited.response.status).toBe(201);
    const accepted=await call("POST","/invites/accept",{token:invited.data.token,email:role+"@example.test",password:"actual member password"});expect(accepted.response.status).toBe(201);
    const session=identity(accepted.response,accepted.data.session);if(role==='editor')editor=session;else viewer=session;
  }
  expect((await call("GET",`/projects/${project}`,undefined,editor)).response.status).toBe(200);
  expect((await call("GET",`/projects/${project}`,undefined,viewer)).response.status).toBe(200);
});
test("actual project editor creates a shared review queue",async()=>{expect((await call("POST",`/projects/${project}/review-queues`,{name:"β queue"},editor)).response.status).toBe(201);});
test("shared queue lookup authenticates before authority or entity lookup",async()=>{expect((await call("GET",`/projects/${project}/review-queues`)).response.status).toBe(401);});
test("viewer remains read only for actual shared review mutation",async()=>{expect((await call("POST",`/projects/${project}/review-queues`,{name:"Forbidden"},viewer)).response.status).toBe(403);});
test("actual editor creates a project-owned curated dataset",async()=>{expect((await call("POST",`/projects/${project}/review-datasets`,{name:"Project β curated cases"},editor)).response.status).toBe(201);});

const runId="1".repeat(32), spanId="2".repeat(16);
async function intake() {
  const key=await call("POST",`/projects/${project}/keys`,{label:"Actual source"},owner);expect(key.response.status).toBe(201);
  const capture=async(output:string,input:string)=> {
    const response=await fetch(url+"/api/team/ingest/v1/traces",{method:"POST",headers:{Origin:url,"Content-Type":"application/json",Authorization:`Bearer ${key.data.token}`},body:JSON.stringify({resourceSpans:[{scopeSpans:[{spans:[{traceId:runId,spanId,name:"Agent β",startTimeUnixNano:"1800000000000000000",endTimeUnixNano:"1800000001000000000",status:{code:1},attributes:[{key:"openinference.span.kind",value:{stringValue:"AGENT"}},{key:"runphantom.input",value:{stringValue:input}},{key:"runphantom.output",value:{stringValue:output}}]}]}]}]})});expect(response.status).toBe(200);
  };
  await capture("Frozen β","Original β");
  const queue=await call("POST",`/projects/${project}/review-queues`,{name:"Actual β"},editor);expect(queue.response.status).toBe(201);
  const path=`/projects/${project}/review-queues/${queue.data.id}`;
  const item=await call("POST",path+"/items",{runId},editor);expect(item.response.status).toBe(201);
  return {path,item:item.data,queue:queue.data,capture};
}

test("native HTTP latest full draft approval, stale CAS and receipt retry preserve frozen β",async()=> {
  const {path,item,capture}=await intake();await capture("Live γ","Changed γ");
  const approved=await call("POST",`${path}/items/${item.id}/approve`,{expectedRevision:item.revision,mutationId:randomUUID(),draft:{...item.draft,name:"Curated latest β",target:{expectedOutput:"Frozen β"}}},editor);
  expect(approved.response.status).toBe(200);expect(approved.data.draft.name).toBe("Curated latest β");expect(approved.data.source.output).toBe("Frozen β");
  expect(approved.data.approvalWitness.accountId).toBe(editor.accountId);expect(approved.data.reviewSource).toBe("projectAccount");
  expect((await call("PUT",`${path}/items/${item.id}`,{expectedRevision:item.revision,mutationId:randomUUID(),draft:item.draft},editor)).response.status).toBe(409);
  const dataset=await call("POST",`/projects/${project}/review-datasets`,{name:"Shared frozen"},editor);expect(dataset.response.status).toBe(201);
  const request={datasetId:dataset.data.datasetId,expectedDatasetVersion:1,idempotencyKey:randomUUID(),items:[{itemId:item.id,expectedRevision:approved.data.revision}]};
  const receipt=await call("POST",path+"/promotions",request,editor);expect(receipt.response.status).toBe(201);
  const retry=await call("POST",path+"/promotions",request,owner);expect(retry.response.status).toBe(201);expect(retry.data).toEqual(receipt.data);
  const revision=await call("GET",`/projects/${project}/review-datasets/${receipt.data.datasetId}/revisions/2`,undefined,viewer);expect(revision.response.status).toBe(200);expect(revision.data.cases[0].sourceOutput).toBe("Frozen β");
  const exported=await call("GET",`/projects/${project}/review-datasets/${receipt.data.datasetId}/revisions/2/export`,undefined,viewer);expect(exported.response.status).toBe(200);
  expect(JSON.stringify(exported.data)).not.toContain(editor.accountId);expect(JSON.stringify(exported.data)).not.toContain(runId);
  expect((await call("DELETE",`${path}/items/${item.id}?expectedRevision=${approved.data.revision+1}`,undefined,editor)).response.status).toBe(403);
  expect((await call("DELETE",`${path}/items/${item.id}?expectedRevision=${approved.data.revision+1}`,undefined,owner)).response.status).toBe(204);
  expect((await call("POST",path+"/promotions",request,owner)).data).toEqual(receipt.data);
});

test("actual concurrent HTTP editors produce one CAS winner and one stale conflict",async()=> {
  const {path,item}=await intake();
  const requests=await Promise.all(["A","B"].map(name=>call("PUT",`${path}/items/${item.id}`,{expectedRevision:item.revision,mutationId:randomUUID(),draft:{...item.draft,name}},editor)));
  expect(requests.map(row=>row.response.status).sort()).toEqual([200,409]);
  const current=await call("GET",`${path}/window?centerId=${item.id}`,undefined,viewer);expect(current.response.status).toBe(200);
  expect(current.data[0].revision).toBe(item.revision+1);expect(["A","B"]).toContain(current.data[0].draft.name);
});

test("closed actual HTTP project/body/query/media and role boundaries refuse without source changes",async()=> {
  const {path,item}=await intake();
  expect((await call("POST",path+"/items",{runId,projectId:project},editor)).response.status).toBe(400);
  expect((await call("POST",`${path}/items/${item.id}/approve`,{expectedRevision:item.revision,mutationId:randomUUID(),draft:{...item.draft,target:{expectedOutput:"Frozen β"}},approvalWitness:{accountId:owner.accountId}},editor)).response.status).toBe(400);
  expect((await call("GET",path+"/items?limit=1&limit=1",undefined,editor)).response.status).toBe(400);
  expect((await call("GET",path+"/items?limit=51",undefined,editor)).response.status).toBe(400);
  for(const headers of [{"Content-Type":"application/json; charset=iso-8859-1"},{"Content-Type":"application/json","Content-Encoding":"br"}]) {
    const response=await fetch(url+"/api/team"+path+"/items",{method:"POST",headers:{Origin:url,Cookie:editor.cookie,"X-RunPhantom-CSRF":editor.csrf,...headers},body:JSON.stringify({runId})});expect(response.status).toBe(415);
  }
  const foreign=await call("POST","/projects",{name:"Foreign"},owner);expect(foreign.response.status).toBe(201);
  expect((await call("GET",`/projects/${foreign.data.id}/review-queues/${path.split('/').at(-1)}/window?centerId=${item.id}`,undefined,editor)).response.status).toBe(404);
  const current=await call("GET",`${path}/window?centerId=${item.id}`,undefined,viewer);expect(current.response.status).toBe(200);expect(current.data[0]).toEqual(item);
});

test("held actual HTTP body loses current editor authority before committing its new draft",async()=> {
  const {path,item}=await intake(), body=JSON.stringify({expectedRevision:item.revision,mutationId:randomUUID(),draft:{...item.draft,name:"Held stale edit"}});
  let finish!:()=>void;
  const response=new Promise<number>((resolve,reject)=> {
    const request=httpRequest(url+"/api/team"+`${path}/items/${item.id}`,{method:"PUT",headers:{Origin:url,Cookie:editor.cookie,"X-RunPhantom-CSRF":editor.csrf,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=> {res.resume();res.once("end",()=>resolve(res.statusCode!));});
    request.once("error",reject);request.write(body.slice(0,1));finish=()=>request.end(body.slice(1));
  });
  await new Promise(resolve=>setTimeout(resolve,40));
  expect((await call("PATCH",`/projects/${project}/members/${editor.accountId}`,{role:"viewer"},owner)).response.status).toBe(200);
  finish();expect(await response).toBe(403);
  expect((await call("GET",`${path}/window?centerId=${item.id}`,undefined,viewer)).data[0]).toEqual(item);
  expect((await call("PATCH",`/projects/${project}/members/${editor.accountId}`,{role:"editor"},owner)).response.status).toBe(200);
});
afterAll(async()=> { if(handle) await handle.close(); if(profile) rmSync(profile,{recursive:true,force:true}); });
