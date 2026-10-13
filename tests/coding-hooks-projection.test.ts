import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../src/server";
import { closeDb, getDrizzleDb } from "../src/db";
import { installationIdForSettings } from "../src/coding-hooks/management";
import { claimsForRegistration } from "../src/coding-hooks/catalog";
import { readClaudeCapabilityDescriptor } from "../src/coding-hooks/capability";
import type { HookAdmission } from "../src/coding-hooks/store";
import type { NormalizedClaudeBatch } from "../src/coding-hooks/claude";
import type { NormalizedSpan } from "../src/spans/normalized";
import type { SnapshotSpan, SnapshotRun } from "../src/evaluations/protocol";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import { hookDigest, HookRefusal } from "../src/coding-hooks/protocol";
import { normalizeStoredSpan } from "../src/spans/normalize";
import { snapshotRun } from "../src/evaluations/snapshot";
import { hookFixture, hookSession, transcriptRecord, transcriptSnapshot } from "./fixtures/coding-hooks-claude";
let dir: string, runtime: Awaited<ReturnType<typeof createServer>>, prior: string | undefined;
interface Row extends SnapshotSpan { model: string|null; input_tokens: number|null; output_tokens: number|null; }
let rows: Row[], run: SnapshotRun, admission: HookAdmission, token: string, publishedBatch: NormalizedClaudeBatch;
beforeEach(async () => {
 closeDb(); prior=process.env.RUNPHANTOM_DB_PATH; dir=realpathSync(mkdtempSync(path.join(tmpdir(),"runphantom-f11-projection-"))); mkdirSync(path.join(dir,"profile")); process.env.RUNPHANTOM_DB_PATH=path.join(dir,"profile/owner.sqlite");
 runtime=await createServer(0); await new Promise<void>(resolve=>runtime.server.listen(0,"127.0.0.1",resolve));
 for(const name of ["workspace/.claude","projects/project"])mkdirSync(path.join(dir,name),{recursive:true});
 const binding={installationId:installationIdForSettings("local",path.join(dir,"workspace/.claude/settings.local.json")),scope:"local" as const,captureMode:"full" as const,workspace:path.join(dir,"workspace"),registeredWorkspace:path.join(dir,"workspace"),transcriptRoot:path.join(dir,"projects"),projectDirectory:path.join(dir,"projects/project"),homeDirectory:dir,settingsPath:path.join(dir,"workspace/.claude/settings.local.json"),executable:realpathSync(path.resolve(import.meta.dir,"../bin/runphantom-dev"))};
 await runtime.codingHooks.management().install(binding,{fullConsent:true});
 const cap=await readClaudeCapabilityDescriptor(path.join(dir,"profile/coding-hooks/claude",binding.installationId+".json"),binding.installationId);
 token=cap.token!; admission=runtime.codingHooks.store.admit(token,"b".repeat(64),claimsForRegistration(binding));
 const record=transcriptRecord({message:{id:"projection_msg",model:"projection-model",content:[{type:"text",text:"Projection distinct assistant"},{type:"tool_use",id:"projection_tool",name:"lookup",input:{count:0,enabled:false}}],stop_reason:"end_turn",usage:{input_tokens:17,output_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
 const user={type:"user",uuid:"projection_user",sessionId:hookSession,version:"2.1.296",timestamp:"2026-10-12T02:59:00.000Z",message:{content:"Projection distinct user"}};
 const value=normalizeClaudeHook(hookFixture("PostToolUse",{tool_use_id:"projection_tool",tool_name:"lookup",tool_input:{count:0,enabled:false},tool_response:false}),{sourceKey:admission.sourceKey,captureMode:"full"},transcriptSnapshot([user,record]));
 if(value.status!=="accepted")throw Error(value.reason); publishedBatch=value.value; expect(runtime.codingHooks.store.publish(cap.token!,admission,value.value).entities).toBe(4);
 const db=getDrizzleDb().$client; rows=db.query("SELECT * FROM spans WHERE run_id=? ORDER BY id").all(admission.runId) as Row[];run=db.query("SELECT * FROM runs WHERE id=?").get(admission.runId) as SnapshotRun;
});
afterEach(async()=>{if(runtime)await new Promise<void>((resolve,reject)=>runtime.server.close(error=>error?reject(error):resolve()));closeDb();if(prior===undefined)delete process.env.RUNPHANTOM_DB_PATH;else process.env.RUNPHANTOM_DB_PATH=prior;if(dir)rmSync(dir,{recursive:true,force:true});});
const kind=(row:Row)=>JSON.parse(row.attributes!).entityKind ?? (row.name==="lookup"?"tool":row.name==="Assistant"?"assistant":row.name==="User prompt observation"?"prompt":"session");
test("published hook kinds use the existing canonical vocabulary without inventing prompt linkage",()=>{
 expect(Object.fromEntries(rows.map(row=>[kind(row),row.span_type]))).toEqual({tool:"TOOL_CALL",assistant:"LLM_GENERATION",prompt:"INTERNAL",session:"AGENT_ROOT"});
 const assistant=rows.find(row=>kind(row)==="assistant")!;expect(assistant.input_payload).toBeNull();expect(rows.every(row=>row.end_time_ms===null&&row.duration_ms===null)).toBe(true);
});
test("actual publisher reaches typed tool args/result preserving numeric zero and boolean false",()=>{
 const raw=rows.find(row=>kind(row)==="tool")!;expect(JSON.parse(raw.input_payload)).toEqual({count:0,enabled:false});expect(JSON.parse(raw.output_payload)).toBe(false);
 expect(normalizeStoredSpan(raw).normalized).toMatchObject({kind:"tool",name:"lookup",args:{count:0,enabled:false},result:false,resultIsError:false});
});
test("actual assistant read is typed with model but contains no invented input conversation",()=>{
 const raw=rows.find(row=>kind(row)==="assistant")!;expect(raw.input_tokens).toBe(17);expect(raw.output_tokens).toBe(5);
 expect(normalizeStoredSpan(raw).normalized).toMatchObject({kind:"llm",model:"projection-model",messages:[],userMessage:"",systemPrompt:""});
 expect(JSON.parse(raw.output_payload)[0]).toEqual({type:"text",text:"Projection distinct assistant"});
});
test("actual frozen snapshot includes observed tool/model metrics while execution remains incomplete",()=>{
 const snapshot=snapshotRun(run,rows);expect(snapshot.tools).toHaveLength(1);expect(snapshot.tools[0]).toMatchObject({name:"lookup",arguments:{status:"incomplete",value:null}});
 expect(snapshot.metrics).toMatchObject({inputTokens:17,outputTokens:5,totalTokens:22,durationMs:null});expect(snapshot.models[0]).toMatchObject({model:"projection-model",inputTokens:17,outputTokens:5});expect(snapshot.complete).toBe(false);expect(snapshot.toolsComplete).toBe(false);expect(snapshot.input).toBeNull();expect(snapshot.output.source).toBe("unavailable");
});
test("actual public detail read exposes typed tool/assistant and keeps producer-only partial attributes",async()=>{
 const response=await fetch(`http://127.0.0.1:${runtime.port}/api/runs/detail/${admission.runId}`);expect(response.status).toBe(200);const detail=await response.json() as {spans:(Row & {normalized:NormalizedSpan})[]};
 expect(detail.spans.find((row)=>row.name==="lookup").normalized).toMatchObject({kind:"tool",args:{count:0,enabled:false},result:false});expect(detail.spans.find((row)=>row.name==="Assistant").normalized).toMatchObject({kind:"llm",messages:[],model:"projection-model"});
 for(const row of detail.spans)expect(JSON.parse(row.attributes)).toMatchObject({producerVerified:false,runtimeVerified:false,coverage:"partial"});
});
test("ordinary recognized TOOL_CALL remains a genuine positive control",()=>{
 expect(normalizeStoredSpan({name:"ordinary",span_type:"TOOL_CALL",input_payload:null,output_payload:null,attributes:JSON.stringify({"ai.toolCall.name":"ordinary","ai.toolCall.args":"0","ai.toolCall.result":"false"})}).normalized).toEqual({kind:"tool",name:"ordinary",args:0,result:false,resultIsError:false});
});

const canonicalColumns="id,run_id,parent_span_id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes,otlp_evidence";
const canonical=()=>getDrizzleDb().$client.query(`SELECT ${canonicalColumns} FROM spans WHERE run_id=? ORDER BY id`).all(admission.runId) as Row[];
const allBytes=()=>JSON.stringify(["coding_hook_owner","coding_hook_installations","coding_hook_sessions","coding_hook_entities","runs","spans"].map(table=>getDrizzleDb().$client.query(`SELECT * FROM ${table} ORDER BY rowid`).all()));
function oldProjections(){
 const db=getDrizzleDb().$client;
 for(const row of canonical()){
  const attrs=JSON.parse(row.attributes),entityKind=attrs.entityKind;delete attrs.captureContract;delete attrs.entityKind;delete attrs.sourceKind;delete attrs.captureModel;
  db.query("UPDATE spans SET span_type=?,attributes=? WHERE run_id=? AND id=?").run(entityKind==="tool"?"tool":entityKind==="assistant"?"llm":"agent",JSON.stringify(attrs),admission.runId,row.id);
  const old=db.query(`SELECT ${canonicalColumns} FROM spans WHERE run_id=? AND id=?`).get(admission.runId,row.id);
  db.query("UPDATE coding_hook_entities SET projection_sha256=? WHERE source_key=? AND span_id=?").run(hookDigest(JSON.stringify(old)),admission.sourceKey,row.id);
 }
}
test("witness-bound old projections upgrade every retained entity without changing cached DTO/observations or cursors",()=>{
 oldProjections();const db=getDrizzleDb().$client;
 const entities=()=>JSON.stringify(db.query("SELECT entity_key,data,observation_sha256,incarnation_key,source_offset FROM coding_hook_entities ORDER BY entity_key").all());
 const cursor=()=>JSON.stringify(db.query("SELECT source_key,source_root_key,incarnation_key,prefix_sha256,prefix_bytes,source_cursor,observed_file_bytes FROM coding_hook_sessions").all());
 const retained=entities(),beforeCursor=cursor();
 const rootOnly=normalizeClaudeHook(hookFixture("Stop"),{sourceKey:admission.sourceKey,captureMode:"metadata"},null);if(rootOnly.status!=="accepted")throw Error(rootOnly.reason);
 expect(rootOnly.value.entities).toHaveLength(1);runtime.codingHooks.store.publish(token,admission,rootOnly.value);
 expect(entities()).toBe(retained);expect(cursor()).toBe(beforeCursor);
 expect(canonical().find(row=>row.name==="lookup")!.span_type).toBe("TOOL_CALL");expect(canonical().find(row=>row.name==="User prompt observation")!.span_type).toBe("INTERNAL");
 expect(snapshotRun(run,canonical()).metrics).toMatchObject({inputTokens:17,outputTokens:5,totalTokens:22});
});
for(const mutation of ["retained-digest","phase-column","canonical-payload"]){
 test(`old projection ${mutation} corruption refuses with every earlier upgrade rolled back`,()=>{
  oldProjections();const db=getDrizzleDb().$client;const last=db.query("SELECT entity_key,span_id FROM coding_hook_entities ORDER BY entity_key DESC LIMIT 1").get() as {entity_key:string;span_id:string};
  if(mutation==="retained-digest")db.query("UPDATE coding_hook_entities SET data=json_set(data,'$.name','forged retained name') WHERE entity_key=?").run(last.entity_key);
  if(mutation==="phase-column")db.query("UPDATE coding_hook_entities SET phase='unknown' WHERE entity_key=?").run(last.entity_key);
  if(mutation==="canonical-payload")db.query("UPDATE spans SET output_payload='FORGED_CANONICAL_REPLACEMENT' WHERE id=?").run(last.span_id);
  const before=allBytes();let error:unknown;try{runtime.codingHooks.store.publish(token,admission,publishedBatch);}catch(e){error=e;}
  expect(error).toBeInstanceOf(HookRefusal);expect((error as HookRefusal).reason).toBe(mutation==="canonical-payload"?"projection_conflict":"corrupt");expect(allBytes()).toBe(before);
 });
}
test("old projection finite transaction deadline refuses and rolls back actual SQLite bytes",()=>{
 oldProjections();const before=allBytes();let clock=0;const timer=spyOn(performance,"now").mockImplementation(()=>clock+=100);
 try{expect(()=>runtime.codingHooks.store.publish(token,admission,publishedBatch)).toThrow("deadline");}finally{timer.mockRestore();}expect(allBytes()).toBe(before);
});
test("closed matching capture rejects unknown/null/unverified/lossy/duplicate/oversized attributes instead of SDK fallback",()=>{
 const original=canonical().find(row=>row.name==="lookup")!,attrs=JSON.parse(original.attributes);
 const variants=[{...attrs,unexpected:true},{...attrs,producerVerified:true},{...attrs,runtimeVerified:true},{...attrs,coverage:"complete"},{...attrs,coverageReasons:["made_up_reason"]},{...attrs,reportedPhase:null},{...attrs,usage:{freshInputTokens:NaN}},{...attrs,captureModel:"x".repeat(16384)},{...attrs,entityKind:"assistant"}];
 for(const a of variants)expect(normalizeStoredSpan({...original,attributes:JSON.stringify({...a,"ai.toolCall.name":"MUST_NOT_FALLBACK"})}).normalized).toEqual({kind:"other"});
 expect(normalizeStoredSpan({...original,attributes:original.attributes.replace('"producerVerified":false','"producerVerified":true,"producerVerified":false')}).normalized).toEqual({kind:"other"});
 expect(normalizeStoredSpan({...original,attributes:original.attributes.replace('"reportedDurationMs":null','"reportedDurationMs":9007199254740993')}).normalized).toEqual({kind:"other"});
});
test("closed tool raw payload read preserves primitives and refuses nonfinite/duplicate/deep/oversized values",()=>{
 const original=canonical().find(row=>row.name==="lookup")!;
 for(const raw of ["0","false","null"]){const value=JSON.parse(raw);expect(normalizeStoredSpan({...original,input_payload:raw,output_payload:raw}).normalized).toMatchObject({kind:"tool",args:value,result:value});}
 for(const raw of ['{"x":0,"x":1}','9007199254740993','1e400','"'+"x".repeat(16384)+'"',"[".repeat(20)+"0"+"]".repeat(20)])expect(normalizeStoredSpan({...original,input_payload:raw}).normalized).toEqual({kind:"other"});
 expect(normalizeStoredSpan({...original,span_type:"tool"}).normalized).toEqual({kind:"other"});
});
test("assistant observed blocks stay bounded and cannot invent prompt messages or parse unknown blocks",()=>{
 const original=canonical().find(row=>row.name==="Assistant")!,normalized=normalizeStoredSpan(original).normalized;
 expect(normalized.capture).toMatchObject({assistantText:"Projection distinct assistant",userText:null,usage:{freshInputTokens:17,outputTokens:5,cacheCreatedInputTokens:0,cacheReadInputTokens:0},producerVerified:false,runtimeVerified:false,coverage:"partial"});
 for(const body of [[{type:"text",text:"forged",extra:true}],[{type:"image",url:"https://example.invalid"}],false,"pretend response"])
  expect(normalizeStoredSpan({...original,output_payload:JSON.stringify(body)}).normalized).toEqual({kind:"other"});
 expect(normalizeStoredSpan({...original,input_payload:JSON.stringify("invented input")}).normalized).toEqual({kind:"other"});
});

test("full retained body stays readable after current authority becomes metadata without promoting new body claims",()=>{
 const store=runtime.codingHooks.store,installed=store.authenticate(token),nextToken="c".repeat(64),config="d".repeat(64);
 const changed=store.prepareInstallation({...installed.binding,captureMode:"metadata"},nextToken,config);
 store.commitInstallation(installed.binding.installationId,changed.installationGeneration,nextToken,config,changed.ownerGeneration);
 const current=store.admit(nextToken,"b".repeat(64),claimsForRegistration(installed.binding));store.publish(nextToken,current,publishedBatch);
 const raw=canonical().find(row=>row.name==="lookup")!;expect(store.authenticate(nextToken).row.capture_mode).toBe("metadata");expect(JSON.parse(raw.attributes!)).toMatchObject({retainedBody:true});expect(normalizeStoredSpan(raw).normalized).toMatchObject({kind:"tool",args:{count:0,enabled:false},result:false});
 expect(snapshotRun(run,canonical()).metrics.inputTokens).toBe(17);
});

test("same cached identity cannot change entity kind during an incoming observation",()=>{
 const before=allBytes(),forged={...publishedBatch,entities:publishedBatch.entities.map(entity=>entity.kind==="tool"?{...entity,kind:"prompt" as const,phase:"complete" as const}:entity)};
 expect(()=>runtime.codingHooks.store.publish(token,admission,forged)).toThrow("corrupt");expect(allBytes()).toBe(before);
});

test("active context capability admits exact coherent old projection read-only before transactional publication upgrade", () => {
  oldProjections(); const before = allBytes();
  const again = runtime.codingHooks.store.admit(token, "b".repeat(64), claimsForRegistration(admission.binding));
  expect(again.sourceKey).toBe(admission.sourceKey); expect(allBytes()).toBe(before);
});
for (const mutation of ["attribute", "type"] as const) {
  test(`active context capability rejects coherent-hash old projection with forged ${mutation} before acquisition`, () => {
    oldProjections(); const db = getDrizzleDb().$client, row = canonical().find(value => value.name === "Assistant")!;
    if (mutation === "attribute") { const attributes = JSON.parse(row.attributes!); attributes.unlistedAuthority = true; db.query("UPDATE spans SET attributes=? WHERE id=? AND run_id=?").run(JSON.stringify(attributes), row.id, row.run_id); }
    else db.query("UPDATE spans SET span_type='INTERNAL' WHERE id=? AND run_id=?").run(row.id, row.run_id);
    const changed = db.query(`SELECT ${canonicalColumns} FROM spans WHERE id=? AND run_id=?`).get(row.id, row.run_id);
    db.query("UPDATE coding_hook_entities SET projection_sha256=? WHERE span_id=? AND source_key=?").run(hookDigest(JSON.stringify(changed)), row.id, admission.sourceKey);
    const before = allBytes(); expect(() => runtime.codingHooks.store.admit(token, "b".repeat(64), claimsForRegistration(admission.binding))).toThrow("corrupt"); expect(allBytes()).toBe(before);
  });
}
