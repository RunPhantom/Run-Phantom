import {test,expect} from "bun:test";
import {once} from "node:events";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import * as protobuf from "protobufjs";
import {createServer} from "../src/server";
import {closeDb,getDrizzleDb} from "../src/db";
import {startTeamFixture} from "./helpers/team-server";
const secret="sk-proj-"+"Q7".repeat(35);
const ast=(op:string,value:string)=>JSON.stringify({version:1,all:[{field:"tag",op,value}]});
async function local(use:(url:string)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),"rp-F31-closure-"));const keys=["RUNPHANTOM_DB_PATH","RUNPHANTOM_SECRET_STORE_PATH"];const old=keys.map(k=>process.env[k]);closeDb();process.env.RUNPHANTOM_DB_PATH=join(dir,"review.db");process.env.RUNPHANTOM_SECRET_STORE_PATH=join(dir,"secrets.json");let server:any;
 try{getDrizzleDb();({server}=await createServer(0));server.listen(0,"127.0.0.1");await once(server,"listening");await use(`http://127.0.0.1:${server.address().port}`);}
 finally{server?.closeAllConnections();if(server?.listening)await new Promise<void>((resolve,reject)=>server.close((e:any)=>e?reject(e instanceof Error?e:new Error(String(e))):resolve()));closeDb();keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});rmSync(dir,{recursive:true,force:true});console.log(JSON.stringify({reviewProfileRemoved:dir}));}
}
async function matches(url:string,path:string,headers:Record<string,string>,op:string,value:string){const response=await fetch(url+path+"?"+new URLSearchParams({filter:ast(op,value)}).toString(),{headers});expect(response.status).toBe(200);const page:any=await response.json();return (page.runs??page.items).map((r:any)=>r.runId??r.id).sort();}
test("actual portable import and search resources do not derive membership or absence from unavailable populations",async()=>{
 const observations:any[]=[];
 await local(async url=>{
  const populations=[...["[REDACTED]","[UNAVAILABLE]","[TRUNCATED]","[UNSERIALIZABLE]",secret].map((marker,index)=>({id:String(index+1).repeat(32),tags:["unsafe-only",marker]})),{id:"8".repeat(32),tags:["safe-valid"]}];
  for(const population of populations){const imported=await fetch(url+"/api/import-run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({format:"runphantom-trace/v1",run:{id:population.id,name:"Portable population",started_at:1800000000000,last_updated_at:1800000000000},spans:[{id:"1".repeat(16),run_id:population.id,name:"Portable step",status:"OK",parent_span_id:null,start_time_ms:1800000000000,end_time_ms:1800000000000,duration_ms:0,attributes:JSON.stringify({tags:population.tags})}],liveEvents:[],annotations:[]})});expect(imported.status).toBe(200);}
  for(const path of ["/api/runs/search","/api/runs/search-hits"]){for(const [op,value,expected]of [["eq","unsafe-only",[]],["ne","missing",["8".repeat(32)]]] as const){const actual=await matches(url,path,{},op,value);observations.push({path,op,value,actual,expected});}}
  const response=await fetch(url+"/api/runs/search-suggestions?field=tag");expect(response.status).toBe(200);const suggestions:any=await response.json();observations.push({path:"/api/runs/search-suggestions",actual:suggestions.values,expected:["safe-valid"],hasMore:suggestions.hasMore});
 });
console.log(JSON.stringify({probe:"actual-portable-tags",observations}));expect(observations.every(o=>JSON.stringify(o.actual)===JSON.stringify(o.expected))).toBe(true);
},20000);

function rawDuplicate(id="6") {
 const source=JSON.parse(body("json",false).toString());source.resourceSpans[0].scopeSpans[0].spans[0].traceId=id.repeat(32);
 return JSON.stringify(source).replace('"values":[{"stringValue":"safe-valid"}]','"values":[{"stringValue":"'+secret+'"}],"v\\u0061lues":[{"stringValue":"raw-safe"}]');
}
test("trace aliases and concurrent request sidecars preserve unrelated values and fail closed for uncertain charset",async()=>{
 await local(async url=>{
  const source=JSON.parse(body("json",false).toString()), captured=source.resourceSpans[0].scopeSpans[0].spans[0];
  const business='{"exact":"first","exact":"last","text":"東京%_"}';
  captured.attributes.push({key:"input.value",value:{stringValue:business}},{key:"output.value",value:{stringValue:"Exact business output"}},{key:"business",value:{stringValue:"first"}});
  const positive=JSON.stringify(source).replace('"stringValue":"first"','"stringValue":"first","stringValue":"last"');
  const aliases=["/v1/traces","/v1/otel/v1/traces","/otel/v1/traces"];
  const responses=await Promise.all([...aliases.map((alias,index)=>fetch(url+alias,{method:"POST",headers:{"content-type":"application/json"},body:rawDuplicate(String(index+1))})),fetch(url+"/v1/traces",{method:"POST",headers:{"content-type":"application/json"},body:positive})]);
  for(const response of responses)expect(response.status).toBe(200);
  const uncertain=JSON.parse(positive);uncertain.resourceSpans[0].scopeSpans[0].spans[0].traceId="5".repeat(32);
  expect((await fetch(url+"/v1/traces",{method:"POST",headers:{"content-type":"application/json; charset=utf-16le"},body:Buffer.from(JSON.stringify(uncertain),"utf16le")})).status).toBe(200);
  for(const path of ["/api/runs/search","/api/runs/search-hits"]){expect(await matches(url,path,{},"eq","raw-safe")).toEqual([]);expect(await matches(url,path,{},"eq","safe-valid")).toEqual(["8".repeat(32)]);expect(await matches(url,path,{},"ne","missing")).toEqual(["8".repeat(32)]);}
  const row=getDrizzleDb().$client.query("SELECT attributes,input_payload,output_payload FROM spans WHERE run_id=?").get("8".repeat(32)) as {attributes:string;input_payload:string;output_payload:string};
  expect(JSON.parse(row.attributes).business).toBe("last");expect(row.input_payload).toBe(business);expect(row.output_payload).toBe("Exact business output");
 });
},20000);

test("actual Team original JSON and gzip preserve safe siblings and refuse raw duplicate carrier conclusions",async()=>{
 const team=await startTeamFixture("raw-tag-source");
 try{
  const setup=await fetch(team.url+"/api/team/setup",{method:"POST",headers:{Origin:team.url,"content-type":"application/json"},body:JSON.stringify({setupCode:team.setupCode,email:"original-tags@example.test",password:"Synthetic original tag passphrase"})});expect(setup.status).toBe(201);
  const account=await setup.json(),cookie=setup.headers.get("set-cookie")!.split(";")[0],mutation={Cookie:cookie,Origin:team.url,"X-RunPhantom-CSRF":account.csrfToken,"content-type":"application/json"};
  const response=await fetch(team.url+"/api/team/projects",{method:"POST",headers:mutation,body:JSON.stringify({name:"Original tag source"})});expect(response.status).toBe(201);const project=await response.json();
  const keyed=await fetch(`${team.url}/api/team/projects/${project.id}/keys`,{method:"POST",headers:mutation,body:JSON.stringify({label:"Synthetic source"})});expect(keyed.status).toBe(201);const key=await keyed.json();
  for(const encoding of ["identity","gzip"]){
   const positive=await fetch(team.url+"/api/team/ingest/v1/traces",{method:"POST",headers:{Authorization:`Bearer ${key.token}`,"content-type":"application/json"},body:body("json",false)});expect(positive.status).toBe(200);
   const raw=Buffer.from(rawDuplicate(encoding==="identity"?"6":"7")), original=Buffer.from(raw);
   const ingested=await fetch(team.url+"/api/team/ingest/v1/traces",{method:"POST",headers:{Authorization:`Bearer ${key.token}`,"content-type":"application/json","content-encoding":encoding},body:encoding==="gzip"?gzipSync(raw):raw});expect(ingested.status).toBe(200);expect(raw.equals(original)).toBe(true);
   for(const path of [`/api/team/projects/${project.id}/runs`,`/api/team/projects/${project.id}/search-hits`]){expect(await matches(team.url,path,{Cookie:cookie},"eq","raw-safe")).toEqual([]);expect(await matches(team.url,path,{Cookie:cookie},"ne","missing")).toEqual(["8".repeat(32)]);}
   const suggestions=await fetch(`${team.url}/api/team/projects/${project.id}/search-suggestions?field=tag`,{headers:{Cookie:cookie}});expect(suggestions.status).toBe(200);expect((await suggestions.json()).values).toEqual(["safe-valid"]);
  }
 }finally{await team.close();}
},30000);
const proto=protobuf.parse(`syntax="proto3";message AnyValue {oneof value{string string_value=1;ArrayValue array_value=5;}}message ArrayValue{repeated AnyValue values=1;}message KeyValue{string key=1;AnyValue value=2;}message Status{int32 code=3;}message Span{bytes trace_id=1;bytes span_id=2;string name=5;fixed64 start_time_unix_nano=7;fixed64 end_time_unix_nano=8;repeated KeyValue attributes=9;Status status=15;}message ScopeSpans{repeated Span spans=2;}message ResourceSpans{repeated ScopeSpans scope_spans=2;}message Export{repeated ResourceSpans resource_spans=1;}`).root.lookupType("Export");
function body(format:string,duplicate:boolean){const tags=(values:string[])=>({arrayValue:{values:values.map(stringValue=>({stringValue}))}});const span={traceId:(duplicate?"7":"8").repeat(32),spanId:"1".repeat(16),name:"Duplicate population",startTimeUnixNano:"1800000000000000000",endTimeUnixNano:"1800000000000000000",status:{code:1},attributes:duplicate?[{key:"tags",value:tags([secret])},{key:"tags",value:tags(["duplicate-safe"])}]:[{key:"tags",value:tags(["safe-valid"])}]};const payload={resourceSpans:[{scopeSpans:[{spans:[format==="json"?span:{...span,traceId:Buffer.from(span.traceId,"hex"),spanId:Buffer.from(span.spanId,"hex")}]}]}]};return format==="json"?Buffer.from(JSON.stringify(payload)):Buffer.from(proto.encode(proto.fromObject(payload)).finish());}
test("actual JSON and protobuf local and Team OTLP duplicate tag attributes remain unknown across summary and hit routes",async()=>{
 const observations:any[]=[];
 const team=await startTeamFixture("F31-independent-duplicates");
 try{await local(async url=>{
  const setup=await fetch(team.url+"/api/team/setup",{method:"POST",headers:{Origin:team.url,"content-type":"application/json"},body:JSON.stringify({setupCode:team.setupCode,email:"independent-duplicate@example.test",password:"Synthetic review passphrase 2026"})});expect(setup.status).toBe(201);const account:any=await setup.json(),cookie=setup.headers.get("set-cookie")!.split(";")[0];const mutation={Cookie:cookie,Origin:team.url,"X-RunPhantom-CSRF":account.csrfToken,"content-type":"application/json"};
  for(const format of ["json","protobuf"]){
   const created=await fetch(team.url+"/api/team/projects",{method:"POST",headers:mutation,body:JSON.stringify({name:"Duplicate "+format})});expect(created.status).toBe(201);const project:any=await created.json();const keyed=await fetch(`${team.url}/api/team/projects/${project.id}/keys`,{method:"POST",headers:mutation,body:JSON.stringify({label:"Independent synthetic exporter"})});expect(keyed.status).toBe(201);const key:any=await keyed.json();
   const cells=[{scope:"local",url,ingest:"/v1/traces",headers:{},paths:["/api/runs/search","/api/runs/search-hits"]},{scope:"Team",url:team.url,ingest:"/api/team/ingest/v1/traces",headers:{Authorization:`Bearer ${key.token}`},paths:[`/api/team/projects/${project.id}/runs`,`/api/team/projects/${project.id}/search-hits`]}];
   for(const cell of cells){const contentType=format==="json"?"application/json":"application/x-protobuf";const positive=await fetch(cell.url+cell.ingest,{method:"POST",headers:{...cell.headers,"content-type":contentType},body:body(format,false)});expect(positive.status).toBe(200);const duplicate=await fetch(cell.url+cell.ingest,{method:"POST",headers:{...cell.headers,"content-type":contentType},body:body(format,true)});expect([200,400]).toContain(duplicate.status);
    for(const path of cell.paths)for(const [op,value,expected]of [["eq","duplicate-safe",[]],["ne","missing",["8".repeat(32)]]] as const){const actual=await matches(cell.url,path,cell.scope==="Team"?{Cookie:cookie}:{},op,value);observations.push({format,scope:cell.scope,resource:path.endsWith("search-hits")?"span-hits":"runs",duplicateIngressStatus:duplicate.status,op,value,actual,expected});}
   }
  }
 });}finally{await team.close();}
console.log(JSON.stringify({probe:"actual-json-protobuf-local-Team-duplicates",observations}));expect(observations.every(o=>JSON.stringify(o.actual)===JSON.stringify(o.expected))).toBe(true);
},30000);

test("actual raw JSON duplicate carrier keys cannot create membership or absence",async()=>{
 await local(async url=>{
  const positive=await fetch(url+"/v1/traces",{method:"POST",headers:{"content-type":"application/json"},body:body("json",false)});expect(positive.status).toBe(200);
  const raw='{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"'+"6".repeat(32)+'","spanId":"'+"1".repeat(16)+'","name":"Original duplicate carrier","startTimeUnixNano":"1800000000000000000","endTimeUnixNano":"1800000000000000000","attributes":[{"key":"tags","value":{"arrayValue":{"values":[{"stringValue":"'+secret+'"}],"values":[{"stringValue":"raw-safe"}]}}}]}]}]}]}';
  const ingress=await fetch(url+"/v1/traces",{method:"POST",headers:{"content-type":"application/json"},body:raw});expect(ingress.status).toBe(200);
  for(const path of ["/api/runs/search","/api/runs/search-hits"]){expect(await matches(url,path,{},"eq","raw-safe")).toEqual([]);expect(await matches(url,path,{},"ne","missing")).toEqual(["8".repeat(32)]);}
  const suggestions=await fetch(url+"/api/runs/search-suggestions?field=tag");expect(suggestions.status).toBe(200);expect((await suggestions.json()).values).toEqual(["safe-valid"]);
 });
},20000);
