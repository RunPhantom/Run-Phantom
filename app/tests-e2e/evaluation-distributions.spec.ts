import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, REPO_ROOT_PATH } from "./fixtures";
import { seedEvaluationRuns, createEvaluationDataset, startEvaluation, EVALUATION_INPUT, EVALUATION_RUNS } from "./evaluation-fixture";
import type { ScoreDistributionAnalysis } from "../../src/evaluations/aggregation-protocol";

test("precise check distributions reconcile real frozen outcomes and the displayed download", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const revision = await createEvaluationDataset(request, runPhantom.url, [{kind:"output",operation:"equals",value:'{"status":"paid"}'},{kind:"json"}]);
  const experiments=[];
  for(const [name,run] of [["Passing capture",EVALUATION_RUNS.baseline],["Failing capture",EVALUATION_RUNS.rejected],["Unknown capture",EVALUATION_RUNS.mismatch]] as const) experiments.push(await startEvaluation(request,runPhantom.url,revision,run,name));
  const storedBefore=await Promise.all(experiments.map(async item=>(await request.get(`${runPhantom.url}/api/evaluations/experiments/${item.id}`)).json()));
  await page.goto(runPhantom.url+"/evaluations");
  const panel=page.getByRole("region",{name:"Score distribution analysis"});
  for(const item of experiments){const checkbox=panel.getByRole("checkbox",{name:new RegExp(`^${item.name} ·`)});await expect(checkbox).toBeVisible();await checkbox.check();}
  await panel.getByRole("combobox",{name:"Exact check",exact:true}).selectOption({label:"Checkout result · Check 1 · Code"});
  await panel.getByRole("spinbutton",{name:"Histogram bins"}).fill("2");
  let observed:ScoreDistributionAnalysis|undefined;
  page.on("response",async response=>{if(response.url().endsWith("/analyses/score-distributions")&&response.ok())observed=await response.json() as ScoreDistributionAnalysis;});
  await panel.getByRole("button",{name:"Analyze distribution",exact:true}).click();
  const result=panel.getByLabel("Distribution results");
  await expect(result).toContainText("3 selected experiments · 2 known / 3 observations · 1 excluded · 1 zero · score");
  await expect(result.locator("dl > div").filter({has:page.getByText("Mean",{exact:true})}).locator("dd")).toHaveText("0.5");await expect(result.locator("dl > div").filter({has:page.getByText("Median",{exact:true})}).locator("dd")).toHaveText("0.5");
  await expect(result.getByLabel("Adjacent numeric trends")).not.toContainText("preferred");
  await expect.poll(()=>observed?.overall.mean).toBe(.5);
  expect(observed?.overall.histogram.map(bin=>bin.count)).toEqual([1,1]);expect(observed?.trend.map(item=>item.preference)).toEqual([null,null]);
  const downloadEvent=page.waitForEvent("download");await result.getByRole("button",{name:"Download distribution JSON"}).click();const download=await downloadEvent;
  const file=testInfo.outputPath(download.suggestedFilename());await download.saveAs(file);const text=await readFile(file,"utf8");expect(JSON.parse(text)).toEqual(observed);
  for(const secret of ["Describe the result of this checkout.",'\\"status\\":\\"paid\\"',revision.hash])expect(text).not.toContain(secret);
  const storedAfter=await Promise.all(experiments.map(async item=>(await request.get(`${runPhantom.url}/api/evaluations/experiments/${item.id}`)).json()));expect(storedAfter).toEqual(storedBefore);
  for(const width of [1440,1280,1024,768,390,320]){
    await page.setViewportSize({width,height:1000});await result.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`No document overflow at ${width}`).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`distribution-${width}.png`)});
    if(width===320){const scroll=result.getByRole("region",{name:"Per-experiment statistics, scroll horizontally"});await scroll.focus();await page.keyboard.press("ArrowRight");await expect.poll(()=>scroll.evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);}
  }
  await panel.getByRole("combobox",{name:"Numeric preference"}).selectOption("lower");await expect(result).toHaveCount(0);await expect(panel.getByRole("button",{name:"Download distribution JSON"})).toHaveCount(0);
  await panel.getByRole("button",{name:"Analyze distribution",exact:true}).click();await expect(result.getByLabel("Adjacent numeric trends")).toContainText("improved for the chosen numeric preference");
  await panel.getByRole("combobox",{name:"Distribution source"}).selectOption("snapshot_metric");
  await panel.getByRole("combobox",{name:"Captured metric"}).selectOption("totalTokens");await panel.getByRole("button",{name:"Analyze distribution",exact:true}).click();
  await expect(result).toContainText("3 known / 3 observations · 0 excluded · 0 zero · tokens");await expect(result.locator("dl > div").filter({has:page.getByText("Mean",{exact:true})}).locator("dd")).toHaveText("100");
  await page.reload();await expect(panel.getByRole("button",{name:"Analyze distribution",exact:true})).toBeDisabled();await expect(result).toHaveCount(0);
});

test("whole frozen metric populations survive actual daemon restart with zero and unavailable evidence",async({page,request},testInfo)=>{
  const profile=await mkdtemp(join(tmpdir(),"rp-distribution-restart-"));
  const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,"127.0.0.1",resolve));const port=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const url=`http://127.0.0.1:${port}`, dbPath=join(profile,"data.db"), pids:number[]=[];
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("RUNPHANTOM_")&&!['ANTHROPIC_API_KEY','OPENAI_API_KEY'].includes(key)));
  let child:ChildProcess|undefined;
  async function start(){
    child=spawn("bun",["src/index.ts","serve"],{cwd:REPO_ROOT_PATH,env:{...env,HOME:profile,USERPROFILE:profile,ANTHROPIC_API_KEY:"",OPENAI_API_KEY:"",RUNPHANTOM_OPENAI_API_KEY:"",RUNPHANTOM_PORT:String(port),RUNPHANTOM_BIND_HOST:"127.0.0.1",RUNPHANTOM_DB_PATH:dbPath,RUNPHANTOM_SECRET_STORE_PATH:join(profile,"secrets.json"),RUNPHANTOM_CLAUDE_CLI_CHAT:"0"},stdio:"ignore"});
    pids.push(child.pid!);await expect.poll(async()=>{if(child?.exitCode!==null)throw Error("Owned source daemon exited");try{return(await request.get(url+"/health")).ok();}catch{return false;}},{timeout:15000}).toBe(true);
  }
  async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const current=child;const stopped=new Promise<void>(resolve=>current.once("exit",()=>resolve()));current.kill("SIGTERM");await Promise.race([stopped,new Promise<void>(resolve=>setTimeout(resolve,2500))]);if(current.exitCode===null&&current.signalCode===null){current.kill("SIGKILL");await stopped;}expect(current.exitCode!==null||current.signalCode!==null).toBe(true);}
  try{
    await start();await seedEvaluationRuns(request,url);
    const traceId="0000000000000000000000000000f270",rootId="0000000000f27001";
    const text=(key:string,value:string)=>({key,value:{stringValue:value}});
    const ingested=await request.post(url+"/v1/traces",{data:{resourceSpans:[{scopeSpans:[{spans:[
      {traceId,spanId:rootId,name:"Zero capture",startTimeUnixNano:"1780000000000000000",endTimeUnixNano:"1780000001000000000",attributes:[text("runphantom.span.kind","agent_root"),text("runphantom.input",EVALUATION_INPUT),text("runphantom.output",'{"status":"paid"}')]},
      {traceId,spanId:"0000000000f27002",parentSpanId:rootId,name:"model.generate",startTimeUnixNano:"1780000000100000000",endTimeUnixNano:"1780000000800000000",attributes:[text("ai.operationId","ai.generateText"),text("ai.response.text",'{"status":"paid"}'),{key:"gen_ai.usage.input_tokens",value:{intValue:"0"}},{key:"gen_ai.usage.output_tokens",value:{intValue:"0"}}]}
    ]}]}]}});expect(ingested.ok()).toBe(true);
    const revision=await createEvaluationDataset(request,url,[{kind:"json"}]);
    const experiments=[];for(const [name,runId]of [["Known tokens",EVALUATION_RUNS.baseline],["Unknown tokens",EVALUATION_RUNS.missing],["Zero tokens",traceId]]as const)experiments.push(await startEvaluation(request,url,revision,runId,name));
    const selection={experimentIds:experiments.map(item=>item.id),selector:{kind:"snapshot_metric",metric:"totalTokens"},direction:"none",bins:2};
    const before=await request.post(url+"/api/evaluations/analyses/score-distributions",{data:selection});expect(before.ok()).toBe(true);const expected=await before.json() as ScoreDistributionAnalysis;
    expect(expected.overall).toMatchObject({population:{total:3,finite:2,excluded:1,zero:1},mean:50,sum:100});
    expect((await request.delete(`${url}/api/evaluations/datasets/${revision.datasetId}`)).status()).toBe(204);
    await stop();await start();const after=await request.post(url+"/api/evaluations/analyses/score-distributions",{data:selection});expect(after.status()).toBe(200);const actual=await after.json() as ScoreDistributionAnalysis;expect(actual).toEqual(expected);
    await page.goto(url+"/evaluations");const panel=page.getByRole("region",{name:"Score distribution analysis"});
    for(const item of experiments)await panel.getByRole("checkbox",{name:new RegExp(`^${item.name} ·`)}).check();
    await panel.getByRole("combobox",{name:"Distribution source"}).selectOption("snapshot_metric");await panel.getByRole("spinbutton",{name:"Histogram bins"}).fill("2");await panel.getByRole("button",{name:"Analyze distribution",exact:true}).click();
    await expect(panel.getByLabel("Distribution results")).toContainText("2 known / 3 observations · 1 excluded · 1 zero · tokens");await page.screenshot({path:testInfo.outputPath("distribution-restarted.png"),fullPage:true});
    const artifact=testInfo.outputPath("restart-proof.json");await mkdir(join(artifact,".."),{recursive:true});await writeFile(artifact,JSON.stringify({pids,sourceCommand:"bun src/index.ts serve",providerKeysBlank:true,cliDisabled:true,deletedDataset:revision.datasetId,before:expected,after:actual},null,2));
  }finally{await stop();await rm(profile,{recursive:true,force:true});await writeFile(testInfo.outputPath("restart-cleanup.json"),JSON.stringify({pids,allOwnedDaemonsReaped:true,profileRemoved:true}));}
});

test("a late real analysis cannot restore results after the selected preference changes",async({page,request,runPhantom})=>{
  await seedEvaluationRuns(request,runPhantom.url);const revision=await createEvaluationDataset(request,runPhantom.url,[{kind:"json"}]);await startEvaluation(request,runPhantom.url,revision,EVALUATION_RUNS.baseline,"Late result");
  await page.goto(runPhantom.url+"/evaluations");const panel=page.getByRole("region",{name:"Score distribution analysis"});await panel.getByRole("checkbox",{name:/^Late result ·/}).check();await panel.getByRole("combobox",{name:"Distribution source"}).selectOption("snapshot_metric");
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let acquired!:()=>void;const fetched=new Promise<void>(resolve=>acquired=resolve);let finished!:()=>void;const delivered=new Promise<void>(resolve=>finished=resolve);
  await page.route("**/analyses/score-distributions",async route=>{const response=await route.fetch();expect(response.status()).toBe(200);acquired();await gate;try{await route.fulfill({response});}catch{/* Selection change can abort this real response. */}finally{finished();}});
  try{await panel.getByRole("button",{name:"Analyze distribution",exact:true}).click();await fetched;await panel.getByRole("combobox",{name:"Numeric preference"}).selectOption("higher");release();await delivered;await expect(panel.getByLabel("Distribution results")).toHaveCount(0);await expect(panel.getByRole("button",{name:"Download distribution JSON"})).toHaveCount(0);await expect(panel.getByRole("button",{name:"Analyze distribution",exact:true})).toBeEnabled();}
  finally{release();await page.unroute("**/analyses/score-distributions");}
});

test("empty, keyboard, retained-ID and real compatibility errors leave no downloadable stale result",async({page,request,runPhantom},testInfo)=>{
  await page.goto(runPhantom.url+"/evaluations");const panel=page.getByRole("region",{name:"Score distribution analysis"});
  await expect(panel.getByRole("button",{name:"Analyze distribution",exact:true})).toBeDisabled();await expect(panel).toContainText("Start an experiment to retain frozen results");
  await panel.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("distribution-empty.png")});
  await seedEvaluationRuns(request,runPhantom.url);
  const first=await createEvaluationDataset(request,runPhantom.url,[{kind:"json"}],"First definition"),second=await createEvaluationDataset(request,runPhantom.url,[{kind:"json"}],"Second definition");
  const a=await startEvaluation(request,runPhantom.url,first,EVALUATION_RUNS.baseline,"Compatible one"),b=await startEvaluation(request,runPhantom.url,second,EVALUATION_RUNS.rejected,"Different definition");
  await page.reload();const checkbox=panel.getByRole("checkbox",{name:/^Compatible one ·/});await checkbox.focus();await page.keyboard.press("Space");await expect(checkbox).toBeChecked();
  await panel.getByRole("combobox",{name:"Distribution source"}).selectOption("snapshot_metric");await panel.getByRole("button",{name:"Analyze distribution",exact:true}).focus();await page.keyboard.press("Enter");await expect(panel.getByLabel("Distribution results")).toContainText("1 selected experiments");
  if(!await panel.getByRole("textbox",{name:"Retained experiment ID"}).isVisible())await panel.getByText(/Choose experiments ·/).click();
  await panel.getByRole("textbox",{name:"Retained experiment ID"}).fill(b.id);await panel.getByRole("button",{name:"Add experiment ID"}).click();
  await expect(panel.getByLabel("Distribution results")).toHaveCount(0);const responsePromise=page.waitForResponse(response=>response.url().endsWith("/analyses/score-distributions"));await panel.getByRole("button",{name:"Analyze distribution",exact:true}).click();expect((await responsePromise).status()).toBe(409);
  await expect(panel.getByRole("alert")).toContainText("identical dataset revisions");await expect(panel.getByRole("button",{name:"Download distribution JSON"})).toHaveCount(0);
  await panel.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("distribution-incompatible.png")});
  expect(a.id).not.toBe(b.id);
});
