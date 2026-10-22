import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import * as protobuf from "protobufjs";
import { createServer } from "../src/server";
import { closeDb, getDrizzleDb } from "../src/db";
import { parseOtlpRequest } from "../src/parse";
import { decodeOtlpProtobuf } from "../src/otlp-protobuf";
import { startTeamFixture } from "./helpers/team-server";

let directory: string, oldPath: string | undefined;
beforeAll(() => { directory=mkdtempSync(join(tmpdir(),"rp-tag-ingress-"));oldPath=process.env.RUNPHANTOM_DB_PATH;closeDb();process.env.RUNPHANTOM_DB_PATH=join(directory,"local.db");getDrizzleDb(); });
afterAll(() => { closeDb();if(oldPath===undefined)delete process.env.RUNPHANTOM_DB_PATH;else process.env.RUNPHANTOM_DB_PATH=oldPath;rmSync(directory,{recursive:true,force:true}); });
const proto=protobuf.parse(`syntax="proto3";
message AnyValue { oneof value { string string_value=1; int64 int_value=3; double double_value=4; ArrayValue array_value=5; KeyValueList kvlist_value=6; } }
message ArrayValue { repeated AnyValue values=1; } message KeyValue { string key=1; AnyValue value=2; } message KeyValueList { repeated KeyValue values=1; }
message Resource { repeated KeyValue attributes=1; } message Scope { repeated KeyValue attributes=3; } message Status { int32 code=3; }
message Span { bytes trace_id=1; bytes span_id=2; string name=5; fixed64 start_time_unix_nano=7; fixed64 end_time_unix_nano=8; repeated KeyValue attributes=9; Status status=15; }
message ScopeSpans { Scope scope=1; repeated Span spans=2; } message ResourceSpans { Resource resource=1; repeated ScopeSpans scope_spans=2; } message Export { repeated ResourceSpans resource_spans=1; }
`).root.lookupType("Export");
const tag="東京%_🌈", secret="sk-proj-"+"Q7".repeat(35);
const strings=(values:string[])=>({arrayValue:{values:values.map(stringValue=>({stringValue}))}});
const cases=[strings([tag,"quoted'value"]),{stringValue:JSON.stringify([tag])},{arrayValue:{values:[{stringValue:tag},{intValue:"4"}]}},strings(Array(65).fill(tag)),strings([tag,"🌈"+"x".repeat(255)]),strings([tag,secret]),strings([]),undefined,strings([tag,"[REDACTED]"])];
function telemetry(format:"json"|"protobuf") {
  const spans=cases.map((value,index)=>({traceId:(index+1).toString(16).repeat(32),spanId:"1".repeat(16),name:"Captured tag ingress",startTimeUnixNano:"1800000000000000000",endTimeUnixNano:"1800000000000000000",status:{code:1},attributes:[
    ...(value?[{key:"tags",value}]:[]),{key:"runphantom.input",value:{stringValue:'{"order":"A-42","exact":"東京%_"}'}},{key:"runphantom.output",value:{stringValue:"Exact captured output"}},
    {key:"other-array",value:strings(["unchanged"])},{key:"other-object",value:{kvlistValue:{values:[{key:"exact",value:{stringValue:"value"}}]}}},
  ]}));
  const resourceSpans=[{resource:{attributes:[{key:"resource-array",value:strings(["resource"])},{key:"tags",value:strings(["resource-only"])}]},scopeSpans:[{scope:{attributes:[{key:"scope-array",value:strings(["scope"])}]},spans}]}];
  if(format==="json")return Buffer.from(JSON.stringify({resourceSpans}));
  const binary={resourceSpans:resourceSpans.map(resource=>({...resource,scopeSpans:resource.scopeSpans.map(scope=>({...scope,spans:scope.spans.map(span=>({...span,traceId:Buffer.from(span.traceId,"hex"),spanId:Buffer.from(span.spanId,"hex")}))}))}))};
  return Buffer.from(proto.encode(proto.fromObject(binary)).finish());
}
const filter=(op="eq",value=tag)=>JSON.stringify({version:1,all:[{field:"tag",op,value}]});
for(const format of ["json","protobuf"] as const) {
  test(`${format} ingress keeps only complete explicit span tag arrays structural`,()=>{
    const bytes=telemetry(format),body=format==="json"?JSON.parse(bytes.toString()):decodeOtlpProtobuf(bytes);
    const spans=parseOtlpRequest(body);
    expect(spans[0].attributes.tags).toEqual([tag,"quoted'value"]);
    for(const index of [1,2,3,4,5,7,8])expect(typeof spans[index].attributes.tags).toBe("string");
    expect(JSON.stringify(spans[5].attributes)).not.toContain(secret);
    expect(spans[6].attributes.tags).toEqual([]);
    for(const span of spans){expect(span.attributes["other-array"]).toBe('["unchanged"]');expect(span.attributes["other-object"]).toBe('{"exact":"value"}');expect(span.attributes["resource-array"]).toBe('["resource"]');expect(span.attributes["scope-array"]).toBe('["scope"]');expect(span.inputPayload).toBe('{"order":"A-42","exact":"東京%_"}');expect(span.outputPayload).toBe("Exact captured output");}
  });
  test(`${format} actual local and Team HTTP tag matching refuses scalar guesses and secret suggestions`,async()=>{
    const local=await createServer(0);local.server.listen(0,"127.0.0.1");await once(local.server,"listening");
    const localUrl=`http://127.0.0.1:${(local.server.address() as {port:number}).port}`;
    const team=await startTeamFixture(`tag-${format}`);
    try {
      const bytes=telemetry(format),contentType=format==="json"?"application/json":"application/x-protobuf";
      expect((await fetch(localUrl+"/v1/traces",{method:"POST",headers:{"content-type":contentType},body:bytes})).status).toBe(200);
      const setup=await fetch(team.url+"/api/team/setup",{method:"POST",headers:{Origin:team.url,"content-type":"application/json"},body:JSON.stringify({setupCode:team.setupCode,email:`tags-${format}@example.test`,password:"Synthetic tag ingress password"})});expect(setup.status).toBe(201);
      const account=await setup.json(),cookie=setup.headers.get("set-cookie")!.split(";")[0];
      const headers={Cookie:cookie,Origin:team.url,"X-RunPhantom-CSRF":account.csrfToken,"content-type":"application/json"};
      const projectResponse=await fetch(team.url+"/api/team/projects",{method:"POST",headers,body:JSON.stringify({name:"Tag ingress fixture"})});expect(projectResponse.status).toBe(201);const project=await projectResponse.json();
      const keyResponse=await fetch(`${team.url}/api/team/projects/${project.id}/keys`,{method:"POST",headers,body:JSON.stringify({label:"Synthetic exporter"})});expect(keyResponse.status).toBe(201);const key=await keyResponse.json();
      expect((await fetch(team.url+"/api/team/ingest/v1/traces",{method:"POST",headers:{Authorization:`Bearer ${key.token}`,"content-type":contentType},body:bytes})).status).toBe(200);
      const endpoints:Array<{url:string;prefix:string;headers:Record<string,string>}>=[{url:localUrl,prefix:"/api/runs",headers:{}},{url:team.url,prefix:`/api/team/projects/${project.id}`,headers:{Cookie:cookie}}];
      for(const endpoint of endpoints) {
        const summaryPath=endpoint.prefix+(endpoint.prefix==="/api/runs"?"/search":"/runs");
        const hitsPath=endpoint.prefix+(endpoint.prefix==="/api/runs"?"/search-hits":"/search-hits");
        for(const path of [summaryPath,hitsPath]){
          const response=await fetch(endpoint.url+path+"?"+new URLSearchParams({filter:filter()}).toString(),{headers:endpoint.headers});expect(response.status).toBe(200);
          const page=await response.json();expect((page.items??page.runs).map((row:{id?:string;runId?:string})=>row.runId??row.id).sort()).toEqual(["1".repeat(32)]);
          const absent=await fetch(endpoint.url+path+"?"+new URLSearchParams({filter:filter("ne")}).toString(),{headers:endpoint.headers});expect(absent.status).toBe(200);const absentPage=await absent.json();expect((absentPage.items??absentPage.runs).map((row:{id?:string;runId?:string})=>row.runId??row.id)).toEqual(["7".repeat(32)]);
          for(const value of [secret,"[REDACTED]","[UNAVAILABLE]"]){const denied=await fetch(endpoint.url+path+"?"+new URLSearchParams({filter:filter("eq",value)}).toString(),{headers:endpoint.headers});expect(denied.status).toBe(200);const deniedPage=await denied.json();expect(deniedPage.items??deniedPage.runs).toEqual([]);}
        }
        const suggestions=await fetch(endpoint.url+endpoint.prefix+"/search-suggestions?field=tag",{headers:endpoint.headers});expect(suggestions.status).toBe(200);const values=(await suggestions.json()).values;expect(values).toEqual(["quoted'value",tag].sort());expect(JSON.stringify(values)).not.toContain(secret);expect(values).not.toContain("resource-only");
      }
      const rows=getDrizzleDb().$client.query("SELECT attributes,input_payload,output_payload FROM spans WHERE run_id=?").all("1".repeat(32)) as Array<{attributes:string;input_payload:string;output_payload:string}>;
      expect(JSON.parse(rows[0].attributes).tags).toEqual([tag,"quoted'value"]);expect(rows[0].input_payload).toBe('{"order":"A-42","exact":"東京%_"}');expect(rows[0].output_payload).toBe("Exact captured output");
    } finally {await team.close();await new Promise<void>(resolve=>local.server.close(()=>resolve()));}
  },20_000);
}
