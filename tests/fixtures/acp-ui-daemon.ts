import { mkdirSync,realpathSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { recordAcpFixtureStage } from "./acp-native-launcher";
import { createServer } from "../../src/server";
import { setActiveWorkspace } from "../../src/active-workspace";
const profile=process.env.RUNPHANTOM_ACP_UI_PROFILE!;
const workspace=path.join(profile,"workspace");mkdirSync(workspace,{recursive:true});setActiveWorkspace(workspace);
assert.equal(process.env.USERPROFILE,profile);assert.equal(realpathSync(homedir()),realpathSync(profile));
assert(process.env.RUNPHANTOM_ACP_FIXTURE_BIN&&path.isAbsolute(process.env.RUNPHANTOM_ACP_FIXTURE_BIN));
process.env.RUNPHANTOM_OPENCODE_BIN=process.env.RUNPHANTOM_ACP_FIXTURE_BIN;
recordAcpFixtureStage(profile,"private-profile");
process.env.RUNPHANTOM_ACP_FIXTURE_MODE=process.env.RUNPHANTOM_ACP_UI_MODE??"positive";
process.env.RUNPHANTOM_ACP_FIXTURE_RECEIPT_PATH=path.join(profile,"native-pids.jsonl");
process.env.RUNPHANTOM_AGENT_PROVIDER="claude";
const {server,close}=await createServer(0);
if(process.env.RUNPHANTOM_ACP_UI_MODE==="actual_mcp"){
 const {upsertRun}=await import("../../src/db");upsertRun({id:"acp_verification_run",name:"Native verification",started_at:Date.now(),last_updated_at:Date.now()});
}
server.listen(Number(process.env.RUNPHANTOM_PORT),"127.0.0.1",()=>recordAcpFixtureStage(profile,"ui-ready"));
const shutdown=()=>{void close().then(()=>{recordAcpFixtureStage(profile,"ui-closed");process.exit(0);},()=>process.exit(1));};
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
