import { afterAll,beforeAll,expect,test } from "bun:test";
import { mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenCodeAcpSessions } from "../src/acp-sessions";
import { compileNativeAcpFixture } from "./fixtures/acp-native-launcher";
let nativeDirectory:string,nativeExecutable:string;
beforeAll(async()=>{nativeDirectory=mkdtempSync(path.join(realpathSync(tmpdir()),"runphantom-acp native-"));nativeExecutable=await compileNativeAcpFixture(nativeDirectory,process.execPath);},20_000);
afterAll(()=>{if(nativeDirectory)rmSync(nativeDirectory,{recursive:true,force:true});});

test("actual isolated native ACP HTTP authority, transitions, portable identity and joined shutdown",async()=>{
 const profile=mkdtempSync(path.join(realpathSync(tmpdir()),"runphantom-acp-http-"));
 const environment:Record<string,string>={};
 for(const key of ["PATH","LANG","LC_ALL","TMPDIR","SHELL"])if(process.env[key])environment[key]=process.env[key]!;
 Object.assign(environment,{HOME:profile,USERPROFILE:profile,TMPDIR:profile,TMP:profile,TEMP:profile,RUNPHANTOM_ACP_FIXTURE_BIN:nativeExecutable,RUNPHANTOM_ACP_HTTP_PROFILE:profile,RUNPHANTOM_DB_PATH:path.join(profile,"traces.db"),RUNPHANTOM_SECRET_STORE_PATH:path.join(profile,"secrets.json")});
 const child=Bun.spawn([process.execPath,path.join(import.meta.dir,"fixtures","acp-http.ts")],{env:environment,cwd:profile,stdout:"pipe",stderr:"pipe"});
 const stdoutPromise=new Response(child.stdout).text();const stderrPromise=new Response(child.stderr).text();
 try{
  const exit=await child.exited;const stdout=await stdoutPromise;const stderr=await stderrPromise;
  const evidence=process.env.RUNPHANTOM_ACP_TEST_EVIDENCE_DIR;
  if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,"stdout.txt"),stdout);writeFileSync(path.join(evidence,"stderr.txt"),stderr);writeFileSync(path.join(evidence,"receipt.json"),JSON.stringify({pid:child.pid,exit,profile,controlledProvider:true,paidRequests:0})+"\n");}
  if(evidence){for(const name of ["native-pids.jsonl","final-controls.json","launch-diagnostic.json"])if(existsSync(path.join(profile,name)))writeFileSync(path.join(evidence,name),readFileSync(path.join(profile,name)));}
  if(exit!==0)throw new Error(`Controlled native ACP HTTP child failed (${exit})\n${stdout}\n${stderr}`);
  const result=JSON.parse(stdout.trim().split("\n").at(-1)!) as {passed:number;paidRequests:number;controlledProvider:boolean;actualInstalledProviderChat:boolean};
  expect(result.passed).toBeGreaterThanOrEqual(10);expect(result.paidRequests).toBe(0);expect(result.controlledProvider).toBe(true);expect(result.actualInstalledProviderChat).toBe(false);
  expect(()=>process.kill(child.pid,0)).toThrow();
 }finally{child.kill();await child.exited;rmSync(profile,{recursive:true,force:true});}
},15_000);

test("one private native launcher initializes both controlled ACP fixtures with explicit arguments",async()=>{
 const profile=mkdtempSync(path.join(realpathSync(tmpdir()),"runphantom-acp-native-control-"));
 try{
  for(const mode of["positive","actual_mcp"]){
   const pids:number[]=[];const receipt=path.join(profile,mode+".jsonl");
   const service=new OpenCodeAcpSessions({command:nativeExecutable,args:["acp","--cwd",profile,"--hostname","127.0.0.1","--port","0"],env:{PATH:process.env.PATH,HOME:profile,USERPROFILE:profile,TMPDIR:profile,TMP:profile,TEMP:profile,RUNPHANTOM_ACP_FIXTURE_MODE:"positive",RUNPHANTOM_ACP_UI_MODE:mode,RUNPHANTOM_ACP_FIXTURE_RECEIPT_PATH:receipt},onProcess(pid){pids.push(pid);}});
   try{
    expect(await service.availability(profile)).toEqual({available:true,authentication:"unknown",protocolVersion:1,version:"fixture-1",sessions:"runphantom_current_daemon"});
    expect(pids).toHaveLength(1);for(const pid of pids)expect(()=>process.kill(pid,0)).toThrow();
    const birth=JSON.parse(readFileSync(receipt,"utf8").trim().split("\n")[0]!);expect(birth.mode).toBe(mode==="actual_mcp"?"controlled_actual_mcp":"positive");expect(birth.argv.slice(2)).toEqual(["acp","--cwd",profile,"--hostname","127.0.0.1","--port","0"]);
   }finally{await service.close();}
  }
 }finally{rmSync(profile,{recursive:true,force:true});}
},5_000);
