import { mkdirSync,writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "../../src/server";
import { setActiveWorkspace } from "../../src/active-workspace";
const profile=process.env.RUNPHANTOM_ACP_UI_PROFILE!;
const workspace=path.join(profile,"workspace");mkdirSync(workspace,{recursive:true});setActiveWorkspace(workspace);
const quote=(value:string)=>`'${value.replace(/'/g,"'\\''")}'`;
const wrapper=path.join(profile,"opencode-fixture");
writeFileSync(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(import.meta.dir,process.env.RUNPHANTOM_ACP_UI_MODE==="actual_mcp"?"acp-verification-provider.ts":"acp-provider.ts"))} "$@"\n`,{mode:0o700});
process.env.RUNPHANTOM_OPENCODE_BIN=wrapper;
process.env.RUNPHANTOM_ACP_FIXTURE_MODE=process.env.RUNPHANTOM_ACP_UI_MODE??"positive";
process.env.RUNPHANTOM_ACP_FIXTURE_RECEIPT_PATH=path.join(profile,"native-pids.jsonl");
process.env.RUNPHANTOM_AGENT_PROVIDER="claude";
const {server,close}=await createServer(0);
if(process.env.RUNPHANTOM_ACP_UI_MODE==="actual_mcp"){
 const {upsertRun}=await import("../../src/db");upsertRun({id:"acp_verification_run",name:"Native verification",started_at:Date.now(),last_updated_at:Date.now()});
}
server.listen(Number(process.env.RUNPHANTOM_PORT),"127.0.0.1");
const shutdown=()=>{void close().then(()=>process.exit(0),()=>process.exit(1));};
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
