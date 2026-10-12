import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamStore, hashTeamToken } from "../src/team/store";
import { normalizeTeamIngest } from "../src/team/ingest";
import { startTeamFixture } from "./helpers/team-server";

const owned: Array<{ dir: string; store: TeamStore }> = [];
afterEach(() => { for (const f of owned.splice(0)) { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); } });
const typed = (all: unknown[]) => ({ version: 1, all });
const clause = (field: string, value: string | number, op = "eq") => ({ field, op, value });
async function refused(promise: Promise<unknown>) {
  const outcome=await promise.then(()=>null,(error:unknown)=>error);
  expect(outcome).toBeInstanceOf(Error);
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rp-typed-team-"));
  const store = new TeamStore(join(dir,"team.sqlite"), { bootstrapHash: hashTeamToken("setup") });
  owned.push({ dir, store });
  const owner = store.setupOwner({ setupCodeHash: hashTeamToken("setup"), email: "search-owner@example.test", passwordHash: "synthetic-password-hash", sessionHash: hashTeamToken("synthetic-session") });
  const a = store.createProject(owner,{ name: "Search A" }), b = store.createProject(owner,{ name: "Search B" });
  const scope = store.projectScope(owner,a.id), foreign = store.projectScope(owner,b.id);
  function seed(project: typeof scope, rows: Array<{ trace: string; id: string; model: string; provider: string; cost?: number }>) {
    const key = store.createKey(project,{ label: "Synthetic exporter" });
    const captures = rows.map(row => ({ traceId: row.trace, spanId: row.id, name: "Synthetic typed capture", startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000000000000000", status: { code: 1 }, attributes: [
      { key: "gen_ai.response.model", value: { stringValue: row.model } },
      { key: "gen_ai.provider.name", value: { stringValue: row.provider } },
      ...(row.cost===undefined?[]:[{ key:"gen_ai.usage.cost_usd",value:{doubleValue:row.cost} }]),
    ] }));
    store.ingest(store.getIngestContext(hashTeamToken(key.token))!, normalizeTeamIngest(Buffer.from(JSON.stringify({resourceSpans:[{scopeSpans:[{spans:captures}]}]})),"json",key.token));
  }
  return { store, owner, scope, foreign, seed };
}

test("Team typed and legacy span clauses share one project and captured occurrence", async () => {
  const f=fixture(), id="1".repeat(32), hit="2".repeat(32);
  f.seed(f.scope,[{trace:id,id:"1".repeat(16),model:"wanted",provider:"other"},{trace:id,id:"2".repeat(16),model:"other",provider:"wanted-provider"},{trace:hit,id:"1".repeat(16),model:"wanted",provider:"wanted-provider",cost:0}]);
  f.seed(f.foreign,[{trace:id,id:"1".repeat(16),model:"wanted",provider:"wanted-provider",cost:0}]);
  const result=await f.store.searchRuns(f.scope,{ provider:"wanted-provider",filter:typed([clause("model","wanted"),clause("captured_cost_usd",0)]) } as never);
  expect(result.items.map(r=>r.id)).toEqual([hit]);
  expect(JSON.stringify(result)).not.toContain("gen_ai.usage.cost_usd");
  expect(result.items[0]).not.toHaveProperty("inputPayload");
  expect((await f.store.searchRuns(f.scope,{ filter:typed([clause("model","wanted"),clause("provider","wanted-provider")]) } as never)).items.map(r=>r.id)).toEqual([hit]);
});

test("Team typed cursors bind canonical meaning and refuse changed or malformed filters", async () => {
  const f=fixture();
  f.seed(f.scope,[1,2,3].map(i=>({trace:String(i).repeat(32),id:"1".repeat(16),model:"m",provider:"p",cost:0})));
  const filter=typed([clause("model","m"),clause("provider","p")]);
  const first=await f.store.searchRuns(f.scope,{filter,limit:1} as never);
  expect(first.items).toHaveLength(1); expect(first.hasMore).toBe(true);
  const next=await f.store.searchRuns(f.scope,{filter:typed([clause("provider","p"),clause("model","m")]),cursor:first.nextCursor,limit:1} as never);
  expect(next.items[0].id).not.toBe(first.items[0].id);
  await refused(f.store.searchRuns(f.scope,{filter:typed([clause("model","other")]),cursor:first.nextCursor} as never));
  await refused(f.store.searchRuns(f.scope,{filter:typed([clause("sql","SELECT 1")])} as never));
});

test("Team typed reads recheck current membership after their worker and never local fallback", async () => {
  const f=fixture(); f.seed(f.scope,[{trace:"1".repeat(32),id:"1".repeat(16),model:"m",provider:"p"}]);
  const invitation=f.store.createInvite(f.scope,{email:"viewer@example.test",role:"viewer"});
  const viewer=f.store.acceptInvite({tokenHash:hashTeamToken(invitation.token),email:"viewer@example.test",expectedAccountId:null,passwordHash:"synthetic-password",sessionHash:hashTeamToken("viewer-session")});
  const viewerScope=f.store.projectScope(viewer.context,f.scope.projectId);
  const pending=f.store.searchRuns(viewerScope,{filter:typed([clause("model","m")])} as never);
  f.store.removeMember(f.scope,viewer.context.user.id);
  await refused(pending);
  await refused(f.store.searchRuns(viewerScope,{filter:typed([])} as never));
});

test("Team hit and suggestion resources keep current project authority before and after acquisition", async()=>{
  const f=fixture();f.seed(f.scope,[{trace:"1".repeat(32),id:"1".repeat(16),model:"own-model",provider:"p",cost:0}]);f.seed(f.foreign,[{trace:"1".repeat(32),id:"1".repeat(16),model:"foreign-model",provider:"p",cost:0}]);
  expect((await f.store.searchSpanHits(f.scope,{filter:typed([clause("captured_cost_usd",0)])})).items.map(row=>row.runId)).toEqual(["1".repeat(32)]);
  expect((await f.store.searchSuggestions(f.scope,{field:"model"})).values).toEqual(["own-model"]);
  const invite=f.store.createInvite(f.scope,{email:"hits-viewer@example.test",role:"viewer"});
  const viewer=f.store.acceptInvite({tokenHash:hashTeamToken(invite.token),email:"hits-viewer@example.test",expectedAccountId:null,passwordHash:"synthetic",sessionHash:hashTeamToken("hits-viewer")});
  const scope=f.store.projectScope(viewer.context,f.scope.projectId), pending=f.store.searchSpanHits(scope,{});
  f.store.removeMember(f.scope,viewer.context.user.id);await refused(pending);await refused(f.store.searchSuggestions(scope,{field:"model"}));
});

test("actual private HTTP activates typed filters and refuses malformed or duplicate query parameters", async () => {
  const service=await startTeamFixture("typed-search");
  try {
    const setup=await fetch(service.url+"/api/team/setup",{method:"POST",headers:{Origin:service.url,"content-type":"application/json"},body:JSON.stringify({setupCode:service.setupCode,email:"typed-owner@example.test",password:"Synthetic typed search password"})});
    expect(setup.status).toBe(201);
    const account=await setup.json(), cookie=setup.headers.get("set-cookie")!.split(";")[0];
    const headers={Cookie:cookie,Origin:service.url,"X-RunPhantom-CSRF":account.csrfToken,"content-type":"application/json"};
    const projectResponse=await fetch(service.url+"/api/team/projects",{method:"POST",headers,body:JSON.stringify({name:"Typed HTTP fixture"})});
    expect(projectResponse.status).toBe(201); const project=await projectResponse.json();
    const keyResponse=await fetch(`${service.url}/api/team/projects/${project.id}/keys`,{method:"POST",headers,body:JSON.stringify({label:"Synthetic exporter"})});
    expect(keyResponse.status).toBe(201); const key=await keyResponse.json();
    const telemetry={resourceSpans:[{scopeSpans:[{spans:[{traceId:"4".repeat(32),spanId:"4".repeat(16),name:"Typed HTTP",startTimeUnixNano:"1800000000000000000",endTimeUnixNano:"1800000000000000000",attributes:[{key:"gen_ai.response.model",value:{stringValue:"literal%_東京"}},{key:"gen_ai.usage.cost_usd",value:{doubleValue:0}}]}]}]}]};
    expect((await fetch(service.url+"/api/team/ingest/v1/traces",{method:"POST",headers:{Authorization:`Bearer ${key.token}`,"content-type":"application/json"},body:JSON.stringify(telemetry)})).status).toBe(200);
    const route=`/api/team/projects/${project.id}/runs`;
    const query=new URLSearchParams({filter:JSON.stringify(typed([clause("model","literal%_東京"),clause("captured_cost_usd",0)]))});
    const result=await fetch(`${service.url}${route}?${query}`,{headers:{Cookie:cookie}}); expect(result.status).toBe(200);
    expect((await result.json()).items.map((item:{id:string})=>item.id)).toEqual(["4".repeat(32)]);
    const hits=await fetch(`${service.url}/api/team/projects/${project.id}/search-hits?${query}`,{headers:{Cookie:cookie}});expect(hits.status).toBe(200);expect((await hits.json()).items[0]).toMatchObject({runId:"4".repeat(32),spanId:"4".repeat(16),input:{state:"unavailable"}});
    const suggestions=await fetch(`${service.url}/api/team/projects/${project.id}/search-suggestions?field=model&prefix=literal%25_`,{headers:{Cookie:cookie}});expect(suggestions.status).toBe(200);expect((await suggestions.json()).values).toEqual(["literal%_東京"]);
    for(const path of ["search-hits?filter=%7B%7D","search-suggestions?field=payload","search-suggestions?field=model&field=tag"])expect((await fetch(`${service.url}/api/team/projects/${project.id}/${path}`,{headers:{Cookie:cookie}})).status).toBe(400);
    for (const invalid of ['{"version":1,"version":1,"all":[]}',JSON.stringify(typed([clause("model","x","regex")])),JSON.stringify(typed([clause("unknown","x")]))]) {
      expect((await fetch(`${service.url}${route}?${new URLSearchParams({filter:invalid})}`,{headers:{Cookie:cookie}})).status).toBe(400);
    }
    expect((await fetch(`${service.url}${route}?filter=%7B%7D&filter=%7B%7D`,{headers:{Cookie:cookie}})).status).toBe(400);
    expect((await fetch(service.url+"/api/runs/search",{headers:{Cookie:cookie}})).status).toBe(404);
  } finally { await service.close(); }
},15_000);
