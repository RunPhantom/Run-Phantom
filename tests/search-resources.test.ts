import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { runMcpServer } from "../src/mcp";
import { clearAll, closeDb, getDrizzleDb } from "../src/db";
import { searchSpanHits, searchSuggestions, localSearchScope } from "../src/search-resources";
import { searchRuns, _runSearchInternal } from "../src/run-search";

let dir: string, oldPath: string | undefined;
beforeAll(() => { dir=mkdtempSync(join(tmpdir(),"rp-search-resources-")); oldPath=process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH=join(dir,"local.db"); getDrizzleDb(); });
beforeEach(clearAll);
afterEach(async () => { const until=Date.now()+10_000; while (_runSearchInternal.activeWorkers() && Date.now()<until) await Bun.sleep(5); expect(_runSearchInternal.activeWorkers()).toBe(0); });
afterAll(() => { closeDb(); if(oldPath===undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH=oldPath; rmSync(dir,{recursive:true,force:true}); });
function seed(id:string, spanId:string, input:string|null, output:string|null, attributes='{"tags":["東京%_", "quoted\'value"]}', model="captured-model", provider="captured-provider") {
  const db=getDrizzleDb().$client;
  db.query("INSERT OR IGNORE INTO runs(id,name,started_at,last_updated_at) VALUES(?,?,100,100)").run(id,id);
  db.query("INSERT INTO spans(run_id,id,name,status,input_payload,output_payload,attributes,model,provider,start_time_ms,duration_ms) VALUES(?,?,?,'OK',?,?,?,?,?,1,0)").run(id,spanId,"Captured step",input,output,attributes,model,provider);
}
const filter=(all:unknown[])=>({version:1,all});
const clause=(field:string,value:string|number,op="eq")=>({field,op,value});

test("hit snippets redact complete evidence before cutting a secret at the excerpt boundary", async()=>{
  const synthetic="sk-proj-"+"Q7".repeat(35), prefix="a".repeat(490);
  seed("safe","root",prefix+synthetic+" needle 🌈 東京",null);
  const page=await searchSpanHits({q:"needle"});
  expect(page.items.map(row=>[row.runId,row.spanId])).toEqual([["safe","root"]]);
  expect(JSON.stringify(page)).not.toContain(synthetic); expect(JSON.stringify(page)).not.toContain("sk-proj-");
  expect(page.items[0].input.state).toBe("available"); expect(page.items[0].input.text).toContain("needle");
  expect(page.items[0].input.highlights).toHaveLength(1);
  const range=page.items[0].input.highlights[0]; expect(page.items[0].input.text.slice(range.start,range.end)).toBe("needle");
  expect(page.items[0].output.state).toBe("unavailable");
  for(const row of page.items) { expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(4096); expect(row.input.text.length).toBeLessThanOrEqual(512); }
  expect(JSON.stringify(await searchRuns({q:"needle"}))).not.toContain("needle");
});

test("oversized complete fields are unavailable and never contribute a partial secret",async()=>{
  seed("large","root","needle "+"x".repeat(8193)+"sk-proj-"+"Q7".repeat(35),"🌈".repeat(2049));
  const row=(await searchSpanHits({q:"needle"})).items[0];
  expect(row.input).toMatchObject({state:"unavailable",text:"",highlights:[]}); expect(row.output.state).toBe("unavailable");
  expect(JSON.stringify(row)).not.toContain("sk-proj-");
});

test("UTF16 excerpt boundaries preserve whole surrogate pairs and the 512 unit cap",async()=>{
  seed("unicode-cut","root","x🌈"+"a".repeat(95)+"needle"+"b".repeat(700),null);
  const text=(await searchSpanHits({q:"needle"})).items[0].input.text;
  expect(text.length).toBeLessThanOrEqual(512);expect(text).toContain("🌈");expect(text).toContain("needle");
  expect(Array.from(text).some(character=>character.length===1&&character.charCodeAt(0)>=0xd800&&character.charCodeAt(0)<=0xdfff)).toBe(false);
});

test("aggregate raw worker admission continues without truncating or losing complete fields",async()=>{
  for(let i=0;i<20;i++)seed("bounded",String(i).padStart(2,"0"),"needle "+"x".repeat(8000),"y".repeat(8100));
  let cursor:string|undefined;const ids:string[]=[];
  do {const page=await searchSpanHits({q:"needle",limit:50,cursor});expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(120_000);expect(page.items.length).toBeLessThan(20);ids.push(...page.items.map(hit=>hit.spanId));cursor=page.nextCursor??undefined;}while(cursor);
  expect(ids).toHaveLength(20);expect(new Set(ids).size).toBe(20);
});

test("hit predicates bind literal text and typed conditions to the actual same span",async()=>{
  seed("mixed","a","100%_done 東京",null,'{"gen_ai.usage.cost_usd":0,"tags":["東京%_"]}',"other");
  seed("mixed","b","100XXdone",null,'{"gen_ai.usage.cost_usd":0,"tags":["東京%_"]}',"wanted");
  seed("hit","a","100%_done 東京",null,'{"gen_ai.usage.cost_usd":0,"tags":["東京%_"]}',"wanted");
  seed("unknown","a","100%_done 東京",null,'{"tags":["東京%_"]}',"wanted");
  const result=await searchSpanHits({q:"100%_done 東京",filter:filter([clause("model","wanted"),clause("captured_cost_usd",0),clause("tag","東京%_")])});
  expect(result.items.map(row=>row.runId)).toEqual(["hit"]);
  expect((await searchSpanHits({q:"' OR 1=1 --"})).items).toEqual([]);
});

test("hit pagination binds store resource and canonical query while preserving span identities",async()=>{
  for(let i=0;i<5;i++) seed("run",String(i),"needle",null);
  const one=await searchSpanHits({q:"needle",limit:2,filter:filter([clause("model","captured-model")])});
  const two=await searchSpanHits({q:"needle",limit:2,filter:filter([clause("model","captured-model")]),cursor:one.nextCursor});
  expect(new Set([...one.items,...two.items].map(row=>row.spanId)).size).toBe(4);
  for(const input of [{q:"other",cursor:one.nextCursor},{q:"needle",cursor:one.nextCursor,filter:filter([clause("model","other")])},{limit:51},{filter:filter([clause("sql","DROP TABLE spans")])}]) expect(await searchSpanHits(input).catch(e=>e)).toBeInstanceOf(Error);
  expect(await searchRuns({cursor:one.nextCursor}).catch(e=>e)).toBeInstanceOf(Error);
  expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThanOrEqual(120_000);
});

test("suggestions are literal, payload-free, scoped and refuse malformed captured tag arrays",async()=>{
  seed("safe","a","private-payload",null); seed("bad","a",null,null,'{"tags":["東京%_",4]}');
  seed("dup","a",null,null,'{"tags":["duplicate"],"tags":[]}'); seed("huge","a",null,null,JSON.stringify({tags:["large"],padding:"x".repeat(65536)}));
  seed("utf16","a",null,null,JSON.stringify({tags:["🌈"+"x".repeat(255),"invalid-companion"]}));
  expect((await searchSuggestions({field:"tag",prefix:"東京%_"})).values).toEqual(["東京%_"]);
  expect((await searchSuggestions({field:"tag",prefix:"invalid-companion"})).values).toEqual([]);
  expect((await searchSuggestions({field:"model",prefix:"captured"})).values).toEqual(["captured-model"]);
  expect(JSON.stringify(await searchSuggestions({field:"provider"}))).not.toContain("private-payload");
  expect(await searchSuggestions({field:"input"}).catch(e=>e)).toBeInstanceOf(Error);
  expect(await searchSuggestions({field:"tag",prefix:"x".repeat(257)}).catch(e=>e)).toBeInstanceOf(Error);
});

test("private local scopes are stable opaque identifiers and resource separated",()=>{
  const a=localSearchScope("runs"), b=localSearchScope("span-hits");
  expect(a).toMatch(/^[a-f0-9]{64}$/); expect(a).toBe(localSearchScope("runs")); expect(a).not.toBe(b); expect(a).not.toContain(dir);
});

test("actual HTTP and MCP expose safe separate resources and closed refusal",async()=>{
  seed("wire","root","literal%_東京 ' OR 1=1 -- password=synthetic-secret",null);
  const {server}=await createServer(0);server.listen(0,"127.0.0.1");await once(server,"listening");
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(), mcp=await runMcpServer({url,transport:serverTransport}), client=new Client({name:"safe-search-resources",version:"1"}); await client.connect(clientTransport);
  try {
    const res=await fetch(`${url}/api/runs/search-hits?${new URLSearchParams({q:"literal%_東京"})}`);expect(res.status).toBe(200);
    const result=await res.json();expect(result.items[0].runId).toBe("wire");expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect((await fetch(url+"/api/runs/search-suggestions?field=model")).status).toBe(200);
    const scoped=await fetch(url+"/api/runs/search-scope?resource=span-hits");expect(scoped.status).toBe(200);expect((await scoped.json()).scope).toMatch(/^[a-f0-9]{64}$/);
    for(const route of ["search-hits?q=a&q=b","search-hits?sql=SELECT","search-hits?filter=%7B%7D","search-suggestions?field=input","search-scope?resource=unknown"])expect((await fetch(url+"/api/runs/"+route)).status).toBe(400);
    const hit=await client.callTool({name:"search_span_hits",arguments:{q:"literal%_東京"}});expect(JSON.parse((hit.content as {text:string}[])[0].text).items[0].spanId).toBe("root");
    const suggestion=await client.callTool({name:"search_suggestions",arguments:{field:"model",prefix:"captured"}});expect(JSON.parse((suggestion.content as {text:string}[])[0].text).values).toEqual(["captured-model"]);
  } finally {await client.close();await mcp.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
