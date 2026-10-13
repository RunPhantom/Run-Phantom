import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { createServer } from "../../src/server";
import { setActiveWorkspace, getActiveWorkspaceSelection } from "../../src/active-workspace";
import { closeDb, getDrizzleDb } from "../../src/db";
import { exportTrace, importTrace } from "../../src/trace-export";
import { parseImportedAnnotations } from "../../src/annotations";

const profile = process.env.RUNPHANTOM_ACP_HTTP_PROFILE!;
assert(profile && process.env.RUNPHANTOM_DB_PATH?.startsWith(profile));
const workspace = path.join(profile,"workspace"); const other = path.join(profile,"other"); const third=path.join(profile,"third");
for(const folder of [workspace,other,third])mkdirSync(folder,{recursive:true});
setActiveWorkspace(workspace);
const receipt=path.join(profile,"native-pids.jsonl");process.env.RUNPHANTOM_ACP_FIXTURE_RECEIPT_PATH=receipt;
process.env.RUNPHANTOM_AGENT_PROVIDER="opencode";process.env.RUNPHANTOM_ACP_FIXTURE_MODE="positive";
const wrapper=path.join(profile,"opencode-fixture");const quote=(value:string)=>`'${value.replace(/'/g,"'\\''")}'`;
writeFileSync(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(import.meta.dir,"acp-provider.ts"))} "$@"\n`,{mode:0o700});
process.env.RUNPHANTOM_OPENCODE_BIN=wrapper;
const unhandled:unknown[]=[];process.on("unhandledRejection",value=>unhandled.push(value));
const {server,app,close}=await createServer(0);server.listen(0,"127.0.0.1");await once(server,"listening");
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function request(url:string,body?:unknown){
 const response=await fetch(base+url,{method:body===undefined?"GET":"POST",headers:{Origin:base,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json() as any};
}
function births(){return existsSync(receipt)?readFileSync(receipt,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line) as {event:string;pid:number;mode:string}):[];}
async function until(check:()=>boolean,timeout=4_000){const start=Date.now();while(!check()){if(Date.now()-start>timeout)throw new Error("Native fixture observation deadline");await Bun.sleep(5);}}
function reaped(){for(const {pid} of births().filter(entry=>entry.event==="birth"))assert.throws(()=>process.kill(pid,0));}
const ws=new WebSocket(base.replace("http:","ws:")+"/ws");await once(ws,"open");
const events:any[]=[];ws.on("message",raw=>events.push(JSON.parse(String(raw))));
const checks:string[]=[];
try {
 const availability=await request(`/api/agent/acp/status?cwd=${encodeURIComponent(workspace)}`);
 assert.equal(availability.status,200);assert.equal(availability.body.available,true);assert.equal(availability.body.authentication,"unknown");assert.match(availability.body.workspaceGeneration,/^[a-f0-9]{64}$/);reaped();checks.push("actual initialize-only API auth unknown and native reap");
 const positive=await request("/api/agent/messages",{cwd:workspace,content:"Controlled question",client_message_id:"positive_1"});
 assert.equal(positive.status,200);assert.equal(positive.body.text,"Permission denied. Fixture answer ✓");assert(positive.body.events.some((event:any)=>event.type==="permission_denied"));assert.equal(positive.body.session.capture.status,"complete");reaped();checks.push("real selected native process, typed permission denial and stored transcript");
 const before=births().length;
 for(const url of ["/api/agent/acp/status","/api/agent/messages/positive_1/cancel"]){const foreign=await request(`${url}?cwd=${encodeURIComponent(other)}`,url.includes("cancel")?{}:undefined);assert.equal(foreign.status,409);}
 assert.equal((await request("/api/agent/messages",{cwd:other,content:"Foreign",client_message_id:"foreign_1"})).status,409);
 assert.equal(births().length,before);checks.push("requested older workspace cannot start status chat or cancellation");
 process.env.RUNPHANTOM_ACP_FIXTURE_MODE="hold_prompt_slow_exit";
 process.env.RUNPHANTOM_ACP_FIXTURE_SESSION_ID="held_inode_session";
 const held=request("/api/agent/messages",{cwd:workspace,content:"Hold",client_message_id:"held_inode"});
 await until(()=>events.some(event=>event.data?.client_message_id==="held_inode"&&event.data.event?.content==="Partial answer"));
 const stateFile=path.join(profile,".runphantom","active-workspace.json"); const literal=readFileSync(stateFile); const generation=getActiveWorkspaceSelection()!.generation;
 const replacement=stateFile+".replacement";writeFileSync(replacement,literal);renameSync(replacement,stateFile);
 assert.notEqual(getActiveWorkspaceSelection()!.generation,generation);
 const heldResult=await held;assert.equal(heldResult.status,502);assert.equal(heldResult.body.category,"scope_changed");reaped();checks.push("identical bytes replacement cannot revive physical selection generation");
 process.env.RUNPHANTOM_ACP_FIXTURE_SESSION_ID="held_transition_session";
 const concurrent=request("/api/agent/messages",{cwd:workspace,content:"Hold transition",client_message_id:"held_transition"});
 await until(()=>events.some(event=>event.data?.client_message_id==="held_transition"&&event.data.event?.content==="Partial answer"));
 const terms=births().filter(entry=>entry.event==="term").length;
 const switchWorkspace=request("/api/workspace/active",{cwd:other});
 await until(()=>births().filter(entry=>entry.event==="term").length>terms);
 assert.equal((await request("/api/workspace/active",{cwd:third})).status,409);
 assert.equal((await request("/api/agent/provider",{provider:"codex"})).status,409);
 assert.equal((await switchWorkspace).status,200);assert.equal(getActiveWorkspaceSelection()!.cwd,other);assert.equal((await concurrent).body.category,"scope_changed");reaped();checks.push("concurrent workspace and provider transitions return409 without stale publication");
 assert.equal((await request("/api/workspace/active",{cwd:workspace})).status,200);
 process.env.RUNPHANTOM_ACP_FIXTURE_SESSION_ID="held_provider_session";
 const cycle=request("/api/agent/messages",{cwd:workspace,content:"Hold provider",client_message_id:"held_provider"});
 await until(()=>events.some(event=>event.data?.client_message_id==="held_provider"&&event.data.event?.content==="Partial answer"));
 const termCount=births().filter(entry=>entry.event==="term").length;
 const away=request("/api/agent/provider",{provider:"claude"});await until(()=>births().filter(entry=>entry.event==="term").length>termCount);
 assert.equal((await request("/api/agent/provider",{provider:"opencode"})).status,409);
 assert.equal((await away).status,200);assert.equal((await request("/api/agent/provider",{provider:"opencode"})).status,200);
 assert.equal((await cycle).body.category,"scope_changed");reaped();checks.push("provider away/back cycle cannot restore old native authority");
 const database=getDrizzleDb().$client;database.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('acp_annotation','ACP identity',1,2)").run();
 const annotation=await request("/api/annotations",{run_id:"acp_annotation",kind:"note",note:"Native identity",source:"opencode"});assert.equal(annotation.status,201);assert.equal(annotation.body.source,"opencode");
 const exported=exportTrace("acp_annotation");assert.equal(parseImportedAnnotations(exported.annotations,"acp_annotation",new Set()).at(0)?.source,"opencode");importTrace(exported);checks.push("actual annotation producer portable export import preserves opencode identity");
 app.get("/__f38/held",(_req,res)=>{res.setHeader("Content-Type","text/event-stream");res.write("data: held\n\n");});
 const heldHttp=await fetch(base+"/__f38/held");const reader=heldHttp.body!.getReader();await reader.read();
 process.env.RUNPHANTOM_ACP_FIXTURE_MODE="hold_initialize_slow_exit";
 const birthCount=births().filter(entry=>entry.event==="birth").length;
 const probe=request(`/api/agent/acp/status?cwd=${encodeURIComponent(workspace)}`).catch(()=>null);
 await until(()=>births().filter(entry=>entry.event==="birth").length>birthCount);
 const started=Date.now();await close();assert(Date.now()-started<2_000);await probe;reaped();assert.equal(server.listening,false);await until(()=>ws.readyState===WebSocket.CLOSED);await reader.read().catch(()=>null);checks.push("native held probe joins before bounded open WS and HTTP SSE shutdown");
 assert.equal(unhandled.length,0);
 // The original callback error must survive closing before listen; no native process is launched.
 let originalError:Error|undefined;
 const nativeClose=Reflect.get(http.Server.prototype,"close") as http.Server["close"];
 http.Server.prototype.close=function(callback){return nativeClose.call(this,error=>{originalError=error;callback?.(error);});};
 const unopened=await createServer(0);http.Server.prototype.close=nativeClose;let closeError:Error|undefined;
 await new Promise<void>(resolve=>unopened.server.close(error=>{closeError=error;resolve();}));
 assert.equal((closeError as NodeJS.ErrnoException)?.code,"ERR_SERVER_NOT_RUNNING");assert.strictEqual(closeError,originalError);
 await Bun.sleep(20);assert.equal(unhandled.length,0);checks.push("original pre-listen close error stays observed");
 const alreadyClosing=await createServer(0);alreadyClosing.server.listen(0,"127.0.0.1");await once(alreadyClosing.server,"listening");
 const closingBase=`http://127.0.0.1:${(alreadyClosing.server.address() as {port:number}).port}`;
 const priorBirths=births().filter(entry=>entry.event==="birth").length;
 const closingProbe=fetch(`${closingBase}/api/agent/acp/status?cwd=${encodeURIComponent(workspace)}`,{headers:{Origin:closingBase}}).catch(()=>null);
 await until(()=>births().filter(entry=>entry.event==="birth").length>priorBirths);
 // Test-owned original native method makes the listener already closing while ACP is held.
 http.Server.prototype.close.call(alreadyClosing.server);
 let alreadyError:Error|undefined;
 await new Promise<void>(resolve=>alreadyClosing.server.close(error=>{alreadyError=error;resolve();}));
 await closingProbe;reaped();assert.equal((alreadyError as NodeJS.ErrnoException)?.code,"ERR_SERVER_NOT_RUNNING");
 await Bun.sleep(20);assert.equal(unhandled.length,0);checks.push("already-closing HTTP error is observed while joining held native probe");
 writeFileSync(path.join(profile,"final-controls.json"),JSON.stringify({originalCallbackErrorIdentityPreserved:closeError===originalError,nativeBirthsAndReaps:births(),unhandledRejections:unhandled.length}));
 console.log(JSON.stringify({checks,passed:checks.length,paidRequests:0,controlledProvider:true,actualInstalledProviderChat:false,nativeBirths:births().filter(entry=>entry.event==="birth").length}));
} finally {
 ws.terminate();await close().catch(()=>{});closeDb();
}
