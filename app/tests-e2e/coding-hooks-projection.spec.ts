import { test, expect } from "./fixtures";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { capabilityOwnerKey } from "../../src/coding-hooks/capability";
import { hookSession, transcriptRecord } from "../../tests/fixtures/coding-hooks-claude";

test("installed hook source observations reach chat without invented assistant input or runtime proof",async({page,runPhantom})=>{
 const home=path.dirname(runPhantom.dbPath),workspace=path.join(home,"hook-workspace");mkdirSync(workspace);
 const installed=await fetch(runPhantom.url+"/api/coding-hooks/claude/manage",{method:"POST",headers:{"content-type":"application/json","x-runphantom-hook-owner":capabilityOwnerKey(runPhantom.dbPath)},body:JSON.stringify({action:"install",scope:"local",workspace,captureMode:"full",fullConsent:true})});expect(installed.status).toBe(200);const receipt=await installed.json() as {captureVerified:boolean;installationId:string};expect(receipt.captureVerified).toBe(false);
 const project=path.join(home,".claude/projects",workspace.replace(/[^A-Za-z0-9.-]+/g,"-")),file=path.join(project,hookSession+".jsonl");
 const user={type:"user",uuid:"browser_user",sessionId:hookSession,version:"2.1.296",timestamp:"2026-10-12T02:59:00.000Z",message:{content:"Projection browser user"}};
 const assistant=transcriptRecord({message:{id:"browser_msg",model:"browser-observation-model",content:[{type:"text",text:"Projection browser assistant"}],stop_reason:"end_turn",usage:{input_tokens:17,output_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});writeFileSync(file,[user,assistant].map(x=>JSON.stringify(x)).join("\n")+"\n");
 const settings=JSON.parse(readFileSync(path.join(workspace,".claude/settings.local.json"),"utf8")) as {hooks:{PostToolUse:{hooks:{command:string;args:string[]}[]}[]}};const vector=settings.hooks.PostToolUse.flatMap((g)=>g.hooks).find((h)=>h.args?.[4]===receipt.installationId)!;expect(vector.args).toEqual(["hooks","handle","claude","--installation-id",receipt.installationId,"--capability-file",path.join(home,"coding-hooks/claude",receipt.installationId+".json")]);
 const child=spawn(vector.command,vector.args,{env:{PATH:process.env.PATH,BUN_RUNTIME_TRANSPILER_CACHE_PATH:"0",ANTHROPIC_API_KEY:"",OPENAI_API_KEY:"",GOOGLE_API_KEY:"",RUNPHANTOM_CLAUDE_CLI_CHAT:"0"},stdio:"pipe"});let stdout="",stderr="";child.stdout.on("data",x=>stdout+=x);child.stderr.on("data",x=>stderr+=x);child.stdin.on("error",()=>{});const started=performance.now();child.stdin.end(JSON.stringify({session_id:hookSession,hook_event_name:"PostToolUse",cwd:workspace,transcript_path:file,tool_use_id:"browser_tool",tool_name:"projectionLookup",tool_input:{count:0,enabled:false},tool_response:false}));const timer=setTimeout(()=>child.kill("SIGKILL"),2000);const code=await new Promise(resolve=>child.on("close",resolve));clearTimeout(timer);expect(code).toBe(0);expect(stdout).toBe("");expect(stderr).toBe("");expect(performance.now()-started).toBeLessThan(1500);
 const runs=await(await fetch(runPhantom.url+"/api/runs")).json() as {id:string}[];expect(runs).toHaveLength(1);const detail=await(await fetch(runPhantom.url+"/api/runs/detail/"+runs[0].id)).json() as {spans:{name:string;input_payload:string|null;end_time_ms:number|null;duration_ms:number|null}[]};expect(detail.spans).toHaveLength(4);expect(detail.spans.find((s)=>s.name==="Assistant")!.input_payload).toBeNull();expect(detail.spans.every((s)=>s.end_time_ms===null&&s.duration_ms===null)).toBe(true);
 await page.goto(runPhantom.url+"/runs/"+runs[0].id,{waitUntil:"networkidle"});
 await expect(page.getByText("Projection browser user",{exact:true})).toBeVisible({timeout:3000});
 await expect(page.getByText("Projection browser assistant",{exact:true})).toBeVisible();
 await expect(page.getByText("projectionLookup",{exact:true}).first()).toBeVisible();
 await expect(page.getByText(/producer.reported.*partial/i).first()).toBeVisible();
 await expect(page.getByRole("button",{name:"Edit message and replay run"})).toHaveCount(0);
 await page.getByRole("button",{name:"Expand tool call projectionLookup"}).click();
 const tool=page.locator("[data-tool-span-id]");
 await expect(tool.locator("pre").nth(0)).toContainText('"count": 0');
 await expect(tool.locator("pre").nth(0)).toContainText('"enabled": false');
 await expect(tool.locator("pre").nth(1)).toHaveText("false");
});
