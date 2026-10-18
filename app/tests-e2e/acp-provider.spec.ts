import {test as base,expect} from "@playwright/test";
import {spawn,type ChildProcess} from "node:child_process";
import {mkdtempSync,realpathSync,readFileSync,existsSync,rmSync,writeFileSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {createServer} from "node:net";
import {createServer as httpServer} from "node:http";
import type {VerificationReport} from "../../src/verification/protocol";
import path from "node:path";
import {fileURLToPath} from "node:url";
import { createNativeAcpFixture } from "../../tests/fixtures/acp-native-launcher";
let nativeDirectory:string,nativeExecutable:string,nativeCompiler:ReturnType<typeof createNativeAcpFixture>|undefined;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
async function port(){return new Promise<number>((resolve,reject)=>{const server=createServer();server.on("error",reject);server.listen(0,"127.0.0.1",()=>{const address=server.address() as {port:number};server.close(error=>error?reject(error):resolve(address.port));});});}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>(resolve=>{child.once("exit",()=>{clearTimeout(timer);resolve();});const timer=setTimeout(()=>child.kill("SIGKILL"),3_000);child.kill("SIGTERM");});}
const test=base.extend<{app:{url:string;profile:string};mode:string}>({
 mode:["positive",{option:true}],
 app:async({mode},use,testInfo)=>{
  const profile=mkdtempSync(path.join(realpathSync(tmpdir()),"runphantom-acp-ui-"));const number=await port();
  const env:Record<string,string>={};for(const key of["PATH","LANG","LC_ALL","TMPDIR","SHELL"])if(process.env[key])env[key]=process.env[key]!;
  Object.assign(env,{HOME:profile,USERPROFILE:profile,TMPDIR:profile,TMP:profile,TEMP:profile,RUNPHANTOM_ACP_FIXTURE_BIN:nativeExecutable,RUNPHANTOM_ACP_UI_PROFILE:profile,RUNPHANTOM_ACP_UI_MODE:mode,RUNPHANTOM_PORT:String(number),RUNPHANTOM_DB_PATH:path.join(profile,"traces.db"),RUNPHANTOM_SECRET_STORE_PATH:path.join(profile,"secrets.json"),RUNPHANTOM_CLAUDE_CLI_CHAT:"0"});
  const child=spawn("bun",[path.join(root,"tests/fixtures/acp-ui-daemon.ts")],{cwd:root,env,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";child.stdout?.on("data",chunk=>{stdout+=String(chunk);});child.stderr?.on("data",chunk=>{stderr+=String(chunk);});
  const url=`http://127.0.0.1:${number}`;const start=Date.now();
  try{
   while(true){if(child.exitCode!==null||child.signalCode!==null)throw new Error("ACP UI daemon exited during boot");try{if((await fetch(url+"/health")).ok)break;}catch{}if(Date.now()-start>15_000)throw new Error("ACP UI daemon health deadline");await new Promise(resolve=>setTimeout(resolve,100));}
   await use({url,profile});
  }finally{
   await stop(child);const diagnostic=path.join(profile,"launch-diagnostic.json");if(existsSync(diagnostic))await testInfo.attach("controlled-native-launch-stage",{path:diagnostic,contentType:"application/json"});await testInfo.attach("native-daemon-stdout",{body:stdout,contentType:"text/plain"});await testInfo.attach("native-daemon-stderr",{body:stderr,contentType:"text/plain"});
   const receipt=path.join(profile,"native-pids.jsonl");expect(existsSync(receipt), "actual native receipt exists").toBe(true);if(existsSync(receipt)){const raw=readFileSync(receipt,"utf8");const proof=testInfo.outputPath("controlled-native-births.jsonl");mkdirSync(path.dirname(proof),{recursive:true});writeFileSync(proof,raw);await testInfo.attach("controlled-native-births",{path:proof,contentType:"application/x-ndjson"});for(const entry of raw.trim().split("\n").map(line=>JSON.parse(line) as {event:string;pid:number}))if(entry.event==="birth")expect(()=>process.kill(entry.pid,0)).toThrow();}
   expect(()=>process.kill(child.pid!,0)).toThrow();rmSync(profile,{recursive:true,force:true});
  }
 },
});
test.beforeAll(async()=>{nativeDirectory=mkdtempSync(path.join(realpathSync(tmpdir()),"runphantom-acp native-ui-"));nativeCompiler=createNativeAcpFixture(nativeDirectory);nativeExecutable=await nativeCompiler.compile("bun");});
test.afterAll(()=>{if(nativeCompiler){if(!nativeCompiler.cleanup().removed)throw new Error("Controlled ACP compiler ownership unconfirmed; private directory retained");}else if(nativeDirectory)throw new Error("Controlled ACP compiler setup unconfirmed; private directory retained");});
async function selectOpenCode(page:import("@playwright/test").Page,url:string){
 await page.goto(url);await page.getByRole("button",{name:"Ask Claude Code",exact:true}).click();
 await page.getByRole("button",{name:"OpenCode",exact:true}).click();await page.getByRole("button",{name:"Connect OpenCode",exact:true}).click();
 await expect(page.getByText("ACP ready. Sign-in has not been verified.",{exact:true})).toBeVisible();
}
test("user selects actual ACP provider, observes typed denied tool and receives its real controlled native response",async({page,app},testInfo)=>{
 const remote:string[]=[];const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 await page.route("**/*",route=>{const url=new URL(route.request().url());if(["127.0.0.1","localhost","[::1]"].includes(url.hostname)||["data:","blob:"].includes(url.protocol))return route.continue();remote.push(url.origin);return route.abort();});
 await selectOpenCode(page,app.url);
 await page.getByRole("button",{name:"New chat",exact:true}).click();
 const responsePromise=page.waitForResponse(response=>response.url().endsWith("/api/agent/messages")&&response.request().method()==="POST");
 await page.getByRole("combobox",{name:"Ask OpenCode",exact:true}).fill("Explain this controlled native ACP result");await page.getByRole("button",{name:"Send message",exact:true}).click();
 const response=await responsePromise;expect(response.status()).toBe(200);const body=await response.json() as {text:string;events:{type:string}[];session_id:string;session:{capture:{status:string}}};
 expect(body.text).toBe("Permission denied. Fixture answer ✓");expect(body.events.some(event=>event.type==="permission_denied")).toBe(true);expect(body.session.capture.status).toBe("complete");
 await expect(page.getByRole("log",{name:"Debug chat messages"}).getByText("Permission denied. Fixture answer ✓",{exact:true})).toBeVisible();
 const folder=path.join(root,".omx/evidence/F38/ui-source-current");mkdirSync(folder,{recursive:true});
 let previousWidth=page.viewportSize()!.width;for(const width of[1440,1280,1024,768,390,320]){await page.setViewportSize({width,height:960});const opener=page.getByRole("button",{name:"Ask OpenCode",exact:true});if(previousWidth>=1280&&width<1280){await expect(opener).toBeVisible();await opener.click();}else if(await opener.isVisible())await opener.click();previousWidth=width;const pane=page.getByLabel("Coding-agent debug chat",{exact:true});await expect(pane).toBeVisible();await expect(page.getByText("ACP ready. Sign-in has not been verified.",{exact:true})).toBeVisible();const visibleAnswer=page.getByRole("log",{name:"Debug chat messages"}).getByText("Permission denied. Fixture answer ✓",{exact:true});await expect(visibleAnswer).toBeVisible();await expect.poll(async()=>pane.evaluate(element=>{const rect=element.getBoundingClientRect();return rect.left>=0&&rect.right<=window.innerWidth&&rect.width<=window.innerWidth-24+1;})).toBe(true);await expect.poll(async()=>visibleAnswer.evaluate(element=>{let node:Element|null=element;while(node){if(Number(getComputedStyle(node).opacity)<1)return false;node=node.parentElement;}return true;})).toBe(true);await page.screenshot({path:path.join(folder,`acp-native-result-${width}.png`),fullPage:true});}
 expect(remote).toEqual([]);expect(errors).toEqual([]);await testInfo.attach("actual-native-HTTP-result",{body:JSON.stringify(body),contentType:"application/json"});
 writeFileSync(path.join(folder,"native-response.json"),JSON.stringify({controlledProvider:true,actualInstalledProviderChat:false,paidRequests:0,result:body},null,2)+"\n");
});
test.describe("actual native cancellation",()=>{
 test.use({mode:"hold_prompt_slow_exit"});
 test("cancel is an actual server action and the native child joins with explicit incomplete result",async({page,app},testInfo)=>{
  await selectOpenCode(page,app.url);await page.getByRole("button",{name:"New chat",exact:true}).click();
  const responsePromise=page.waitForResponse(response=>response.url().endsWith("/api/agent/messages")&&response.request().method()==="POST");
  await page.getByRole("combobox",{name:"Ask OpenCode",exact:true}).fill("Hold a native answer");await page.getByRole("button",{name:"Send message",exact:true}).click();
  await expect(page.getByText("Partial answer",{exact:true})).toBeVisible();await page.getByRole("button",{name:"Cancel OpenCode response",exact:true}).click();
  const response=await responsePromise;expect(response.status()).toBe(409);expect((await response.json() as {category:string}).category).toBe("cancelled");
  await expect(page.getByRole("alert")).toContainText("cancelled");await page.getByRole("combobox",{name:"Ask OpenCode",exact:true}).fill("A new question after cancellation");await expect(page.getByRole("button",{name:"Send message",exact:true})).toBeEnabled();
  await testInfo.attach("cancelled-native-UI",{body:await page.screenshot(),contentType:"image/png"});
 });
});

test.describe("actual optional verification MCP",()=>{
 test.use({mode:"actual_mcp"});
 test("cooperative real SDK browser reaches the real MCP child and persisted pass/fail reports through ACP",async({page,context,request,app},testInfo)=>{
  const target=httpServer((_req,res)=>{res.writeHead(200,{"Content-Type":"text/html"});res.end('<!doctype html><html lang="en"><head><title>Actual SDK target</title></head><body><h1>Application check</h1><output id="verified">Ready</output></body></html>');});
  await new Promise<void>(resolve=>target.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${(target.address() as {port:number}).port}`;
  const runtime=await context.newPage();
  try{
   await page.goto(app.url+"/verification");await page.getByLabel(/^App origin/).fill(origin);await page.getByLabel(/^Link to run \(optional\)/).selectOption("acp_verification_run");await page.getByRole("button",{name:"Pair app",exact:true}).click();
   const snippet=await page.getByLabel("Application connection snippet",{exact:true}).innerText();
   const id=/["']?sessionId["']?\s*:\s*["']([^"']+)["']/.exec(snippet)?.[1];const token=/["']?token["']?\s*:\s*["']([^"']+)["']/.exec(snippet)?.[1];if(!id||!token)throw new Error("Real setup snippet is missing native session credentials");
   await runtime.goto(origin);await runtime.evaluate(async({daemon,sessionId,credential})=>{const sdk=await import(`${daemon}/verification/sdk.js`);(window as unknown as {acpRuntime:unknown}).acpRuntime=sdk.connect({url:daemon,sessionId,token:credential});},{daemon:app.url,sessionId:id,credential:token});
   await expect.poll(async()=>{const response=await request.get(app.url+"/api/verification/sessions");return((await response.json())as Array<{id:string;connected:boolean}>).find(session=>session.id===id)?.connected;}).toBe(true);
   await selectOpenCode(page,app.url+"/runs/acp_verification_run");
   const results:VerificationReport[]=[];
   for(const expected of["pass","fail"]as const){
    await page.getByRole("button",{name:"New chat",exact:true}).click();const answer=page.waitForResponse(response=>response.url().endsWith("/api/agent/messages")&&response.request().method()==="POST");
    await page.getByRole("combobox",{name:"Ask about this trace",exact:true}).fill(expected==="pass"?"Verify the application element":"Verify missing application element");await page.getByRole("button",{name:"Send message",exact:true}).click();
    const response=await answer;expect(response.status()).toBe(200);const body=await response.json()as {text:string;session:{capture:{status:string}};events:{type:string;mcps?:string[]}[]};expect(body.text).toContain(`Verification report: ${expected}.`);expect(body.session.capture.status).toBe("complete");expect(body.events.some(event=>event.type==="loadout"&&event.mcps?.includes("runphantom_verification"))).toBe(true);
    const reports=await request.get(app.url+"/api/verification/reports?runId=acp_verification_run");const report=(await reports.json()as VerificationReport[]).find(item=>item.status===expected);expect(report).toBeDefined();expect(report!.sessionId).toBe(id);expect(report!.runId).toBe("acp_verification_run");expect(report!.context!.checks[0]!.complete).toBe(true);expect(report!.context!.checks[0]!.settled).toBe(true);expect(report!.evidence.some(event=>event.type==="dom")).toBe(true);results.push(report!);
   }
   // Disconnect a real SDK document while the actual MCP assertion is pending. The
   // real service retains an inconclusive report; the revoked grant cannot return it as success.
   const receiptPath=path.join(app.profile,"native-pids.jsonl");
   const assertionCount=()=>readFileSync(receiptPath,"utf8").split("\n").filter(line=>line.includes('"assert_started"')).length;
   const previousAssertions=assertionCount();await page.getByRole("button",{name:"New chat",exact:true}).click();const interrupted=page.waitForResponse(response=>response.url().endsWith("/api/agent/messages")&&response.request().method()==="POST");
   await page.getByRole("combobox",{name:"Ask about this trace",exact:true}).fill("Verify disconnect during the actual check");await page.getByRole("button",{name:"Send message",exact:true}).click();await expect.poll(assertionCount).toBe(previousAssertions+1);
   await runtime.evaluate(()=>{(window as unknown as {acpRuntime:{disconnect():void}}).acpRuntime.disconnect();});
   const interruptedResponse=await interrupted;expect(interruptedResponse.status()).toBe(502);expect((await interruptedResponse.json()as {category:string}).category).toBe("unavailable");
   const persisted=await request.get(app.url+"/api/verification/reports?runId=acp_verification_run");const inconclusive=(await persisted.json()as VerificationReport[]).find(report=>report.status==="inconclusive");expect(inconclusive).toBeDefined();expect(inconclusive!.context!.checks[0]!.complete).toBe(false);results.push(inconclusive!);
   await page.getByRole("button",{name:"Hide chat",exact:true}).click();await page.goto(app.url+"/verification?runId=acp_verification_run");
   for(const expected of["pass","fail","inconclusive"])await expect(page.getByRole("article",{name:`Native ACP application check: ${expected}`,exact:true})).toBeVisible();
   await page.getByRole("article",{name:"Native ACP application check: pass",exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole("article",{name:"Native ACP application check: pass",exact:true})).toBeInViewport();
   const folder=path.join(root,".omx/evidence/F38/ui-source-current");mkdirSync(folder,{recursive:true});await page.screenshot({path:path.join(folder,"acp-actual-mcp-reports.png"),fullPage:true});
   await page.getByRole("article",{name:"Native ACP application check: inconclusive",exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole("article",{name:"Native ACP application check: inconclusive",exact:true})).toBeInViewport();await page.screenshot({path:path.join(folder,"acp-actual-mcp-inconclusive.png"),fullPage:true});
   writeFileSync(path.join(folder,"actual-mcp-reports.json"),JSON.stringify({controlledACPProvider:true,actualRunPhantomMcp:true,actualBrowserSDK:true,actualPersistedGrades:true,actualInstalledProviderChat:false,paidRequests:0,reports:results},null,2)+"\n");await testInfo.attach("actual-persisted-verification-reports",{body:JSON.stringify(results),contentType:"application/json"});
  }finally{await runtime.close();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}
 });
});
