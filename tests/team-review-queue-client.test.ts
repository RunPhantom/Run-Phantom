import { afterEach, expect, spyOn, test } from "bun:test";
import { TeamClient, type SessionResponse } from "../app/src/api/team";
import { teamReviewApi, teamDraftApi, teamDraftItem } from "../app/src/team/review-queues-client";
import { ReviewDrafts } from "../app/src/components/review-queues/drafts";
import { createTeamReviewItem, mutateTeamReviewItem } from "../src/team/review-queues";
import { DEFAULT_REVIEW_SCHEMA } from "../src/review-queues/validation";
import type { TeamReviewItem } from "../src/team/review-queue-protocol";

const project="11111111-1111-1111-1111-111111111111",queue="22222222-2222-2222-2222-222222222222",account="33333333-3333-3333-3333-333333333333";
const session=(id="session-a"):SessionResponse=>({authenticated:true,setupRequired:false,user:{id:account,email:"member@example.test",isOwner:false,createdAt:1},session:{id,current:true,createdAt:1,lastActiveAt:1,expiresAt:100,idleExpiresAt:100},csrfToken:"csrf-fixture"});
const mocks:Array<{mockRestore:()=>void}>=[];afterEach(()=>{for(const mock of mocks.splice(0))mock.mockRestore();});
function respond(run:(url:string,init?:RequestInit)=>Promise<Response>|Response){mocks.push(spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>run(String(input),init)));}
async function failure(request:Promise<unknown>){try{await request;}catch(error){return error;}throw new Error("Expected refusal");}
function client(){const client=new TeamClient(()=>{});client.setSession(session());return client;}
function item(id="1".repeat(32),output="Frozen β"):TeamReviewItem {
  return createTeamReviewItem(project,queue,DEFAULT_REVIEW_SCHEMA,{version:1,runId:id,requestedOutputSpanId:null,resolvedOutputSpanId:"2".repeat(16),runName:"Frozen β",capturedAt:1,input:"Original β",output,sourceSnapshotVersion:1,complete:true,outputComplete:true,redacted:false,truncated:false,warnings:[]},1,1);
}

test("Team review transport scopes project URLs and preserves session CSRF while DELETE remains bodyless",async()=> {
  const api=teamReviewApi(client(),project), stored=item();let requests=0;
  respond((url,init)=>{requests++;expect(url).toStartWith(`/api/team/projects/${project}/review-queues/${queue}/items/${stored.id}`);expect(init).toMatchObject({credentials:"same-origin",cache:"no-store"});
    if(init?.method==="DELETE"){expect(url).toEndWith("?expectedRevision=1");expect(init.body).toBeUndefined();expect(init.headers).toEqual({Accept:"application/json","X-RunPhantom-CSRF":"csrf-fixture"});return new Response(null,{status:204});}
    expect(init?.headers).toEqual({Accept:"application/json","Content-Type":"application/json","X-RunPhantom-CSRF":"csrf-fixture"});return Response.json(stored);
  });
  await api.mutate(queue,stored.id,"save",{expectedRevision:1,mutationId:"mutation",draft:stored.draft});await api.deleteItem(queue,stored.id,1);expect(requests).toBe(2);
  expect(()=>teamReviewApi(client(),"foreign/path")).toThrow("Choose a project");
});

test("exact64KiB requests and finite2MiB replies refuse next bytes without widening original Team transports",async()=> {
  let requests=0;respond(()=>{requests++;return Response.json({ok:true});});const transport=client(),path=`/projects/${project}/review-queues`;
  const overhead=JSON.stringify({padding:""}).length;expect(await transport.reviews(path,{method:"POST",body:{padding:"x".repeat(65536-overhead)}})).toEqual({ok:true});
  expect(await failure(transport.reviews(path,{method:"POST",body:{padding:"x".repeat(65537-overhead)}}))).toMatchObject({status:413});expect(requests).toBe(1);
  mocks.splice(0).forEach(mock=>mock.mockRestore());let canceled=false;
  respond(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){canceled=true;}})));
  expect(await failure(transport.reviews(path))).toMatchObject({status:502,code:"invalid_response"});expect(canceled).toBe(true);
  expect(await failure(transport.reviews("/review-queues"))).toMatchObject({status:400});
});

test("a changed session suppresses a held actual Team review response",async()=> {
  const transport=client();let controller!:ReadableStreamDefaultController<Uint8Array>;
  respond(()=>new Response(new ReadableStream<Uint8Array>({start(value){controller=value;}})));
  const request=transport.reviews(`/projects/${project}/review-queues`);transport.setSession(session("session-b"));
  controller.enqueue(new TextEncoder().encode("[]"));controller.close();expect(await failure(request)).toMatchObject({name:"AbortError"});
});

test("metadata replies cannot smuggle source objects and fullsource windows remain finite",async()=> {
  const api=teamReviewApi(client(),project),stored=item(),summary={id:stored.id,ordinal:1,name:"β",revision:1,state:"draft"};
  respond(()=>Response.json({items:[{...summary,source:stored.source}],counts:{total:1,draft:1,approved:0,promoted:0},hasMore:false,nextCursor:null}));
  expect(await failure(api.page(queue))).toMatchObject({status:502});
  mocks.splice(0).forEach(mock=>mock.mockRestore());respond(()=>Response.json(Array.from({length:6},()=>stored)));
  expect(await failure(api.window(queue,stored.id))).toMatchObject({status:502});
});

test("Team draft adapter reuses newest-edit ACK approval and stores actual witness only in the display window",async()=> {
  const api=teamReviewApi(client(),project);let stored=item("1".repeat(32),"source-only-marker-β"),release!:()=>void,first=true;const seen:unknown[]=[],windowItems=[stored];
  respond(async(_url,init)=> {
    const request=JSON.parse(String(init?.body));seen.push(request);
    if(first){first=false;await new Promise<void>(resolve=>{release=resolve;});}
    stored=mutateTeamReviewItem(project,stored,DEFAULT_REVIEW_SCHEMA,_url.endsWith("/approve")?"approve":"save",request,{accountId:account,role:"editor"},stored.updatedAt+1);return Response.json(stored);
  });
  const drafts=new ReviewDrafts(teamDraftApi(api,next=>{windowItems[0]=next;}),600),core=teamDraftItem(stored);
  drafts.edit(core,{...core.draft,target:{expectedOutput:"First"}});const saving=drafts.save(core.id);
  drafts.edit(core,{...core.draft,target:{expectedOutput:"Latest β"}});const approving=drafts.approve(core);
  const retained=drafts.entries.get(core.id)!;expect(Object.keys(retained.server).sort()).toEqual(["id","queueId","revision","state"]);
  expect(JSON.stringify([...drafts.entries.values()])).not.toContain("source-only-marker-β");expect(retained.draft.input).toBe("Original β");release();await saving;await approving;
  expect(seen).toHaveLength(2);expect(windowItems[0].draft.target.expectedOutput).toBe("Latest β");expect(windowItems[0].approvalWitness?.accountId).toBe(account);expect(drafts.entries.size).toBe(0);drafts.dispose();
});
