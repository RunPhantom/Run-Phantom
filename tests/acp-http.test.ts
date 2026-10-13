import { expect,test } from "bun:test";
import { mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("actual isolated native ACP HTTP authority, transitions, portable identity and joined shutdown",async()=>{
 const profile=mkdtempSync(path.join(realpathSync(tmpdir()),"runphantom-acp-http-"));
 const environment:Record<string,string>={};
 for(const key of ["PATH","LANG","LC_ALL","TMPDIR","SHELL"])if(process.env[key])environment[key]=process.env[key]!;
 Object.assign(environment,{HOME:profile,RUNPHANTOM_ACP_HTTP_PROFILE:profile,RUNPHANTOM_DB_PATH:path.join(profile,"traces.db"),RUNPHANTOM_SECRET_STORE_PATH:path.join(profile,"secrets.json")});
 const child=Bun.spawn([process.execPath,path.join(import.meta.dir,"fixtures","acp-http.ts")],{env:environment,cwd:profile,stdout:"pipe",stderr:"pipe"});
 const stdoutPromise=new Response(child.stdout).text();const stderrPromise=new Response(child.stderr).text();
 try{
  const exit=await child.exited;const stdout=await stdoutPromise;const stderr=await stderrPromise;
  const evidence=process.env.RUNPHANTOM_ACP_TEST_EVIDENCE_DIR;
  if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,"stdout.txt"),stdout);writeFileSync(path.join(evidence,"stderr.txt"),stderr);writeFileSync(path.join(evidence,"receipt.json"),JSON.stringify({pid:child.pid,exit,profile,controlledProvider:true,paidRequests:0})+"\n");}
  if(exit!==0)throw new Error(`Controlled native ACP HTTP child failed (${exit})\n${stdout}\n${stderr}`);
  if(evidence){for(const name of ["native-pids.jsonl","final-controls.json"])if(existsSync(path.join(profile,name)))writeFileSync(path.join(evidence,name),readFileSync(path.join(profile,name)));}
  const result=JSON.parse(stdout.trim().split("\n").at(-1)!) as {passed:number;paidRequests:number;controlledProvider:boolean;actualInstalledProviderChat:boolean};
  expect(result.passed).toBeGreaterThanOrEqual(10);expect(result.paidRequests).toBe(0);expect(result.controlledProvider).toBe(true);expect(result.actualInstalledProviderChat).toBe(false);
  expect(()=>process.kill(child.pid,0)).toThrow();
 }finally{child.kill();await child.exited;rmSync(profile,{recursive:true,force:true});}
},15_000);
