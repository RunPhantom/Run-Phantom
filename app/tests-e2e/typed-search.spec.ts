import { mkdirSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import path from "node:path";
import { test, expect, REPO_ROOT_PATH } from "./fixtures";

const run=(n:number)=>String(n).repeat(32), span=(n:number)=>String(n).repeat(16);
const evidence=path.join(REPO_ROOT_PATH,"output/playwright/typed-search");
async function seed(request: APIRequestContext, url:string) {
  const attr=(key:string,value:string|number)=>({key,value:typeof value==="number"?{doubleValue:value}:{stringValue:value}});
  const rows=[{traceId:run(1),spanId:span(1),model:"wanted-model",provider:"wanted-provider",cost:0,text:"literal%_東京 ' OR 1=1 -- safe <script>window.searchInjected=true</script>"},
    {traceId:run(2),spanId:span(1),model:"wanted-model",provider:"other-provider",cost:0,text:"literal%_東京"},{traceId:run(2),spanId:span(2),model:"other-model",provider:"wanted-provider",cost:0,text:"separate occurrence"},
    {traceId:run(3),spanId:span(1),model:"wanted-model",provider:"wanted-provider",text:"literal%_東京"}];
  const response=await request.post(url+"/v1/traces",{data:{resourceSpans:[{scopeSpans:[{spans:rows.map(r=>({traceId:r.traceId,spanId:r.spanId,name:"Typed capture",startTimeUnixNano:"1800000000000000000",endTimeUnixNano:"1800000000000000000",status:{code:1},attributes:[attr("input.value",r.text),attr("gen_ai.request.model",r.model),attr("gen_ai.provider.name",r.provider),{key:"tags",value:{arrayValue:{values:[{stringValue:"東京%_"}]}}},...(r.cost===undefined?[]:[attr("gen_ai.usage.cost_usd",r.cost)])]}))}]}]}});expect(response.ok()).toBe(true);
}

test("typed local controls drive same-span results suggestions undo redo and scoped recent queries",async({page,request,runPhantom})=>{
  await seed(request,runPhantom.url);await page.goto(runPhantom.url+"/search");
  await page.getByRole("button",{name:"Advanced filters",exact:true}).click();
  await page.getByLabel("Filter field",{exact:true}).selectOption("model");await page.getByLabel("Filter value",{exact:true}).fill("wanted");
  await expect(page.locator('datalist option[value="wanted-model"]')).toHaveCount(1);
  await page.getByLabel("Filter value",{exact:true}).fill("wanted-model");await page.getByRole("button",{name:"Add filter",exact:true}).click();
  await page.getByLabel("Filter field",{exact:true}).selectOption("captured_cost_usd");await page.getByLabel("Filter value",{exact:true}).fill("0");await page.getByRole("button",{name:"Add filter",exact:true}).click();
  await page.getByLabel("Provider",{exact:true}).fill("wanted-provider");
  await expect(page.locator("[data-run-id]")).toHaveCount(1);await expect(page.locator(`[data-run-id="${run(1)}"]`)).toBeVisible();
  await page.getByRole("button",{name:"Undo filters",exact:true}).click();await page.getByRole("button",{name:"Redo filters",exact:true}).click();
  await page.getByLabel("Search captured runs",{exact:true}).fill("literal%_東京");
  await page.getByLabel("Search result type",{exact:true}).selectOption("span-hits");
  await expect(page.locator("[data-span-hit]")).toHaveCount(1);await expect(page.locator("[data-span-hit] mark").first()).toHaveText("literal%_東京");
  expect(await page.evaluate(()=>Boolean((window as unknown as {searchInjected?:boolean}).searchInjected))).toBe(false);
  await page.getByRole("button",{name:"Save search",exact:true}).click();await page.reload();
  await page.getByRole("button",{name:"Advanced filters",exact:true}).click();await expect(page.getByLabel("Recent searches",{exact:true})).toContainText("literal%_東京");
  await expect(page.locator("[data-span-hit]")).toHaveCount(1);
  const scope=await (await request.get(runPhantom.url+"/api/runs/search-scope?resource=span-hits")).json();
  const keys=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("runphantom:search:local:")));
  expect(keys.some(k=>k.endsWith(scope.scope))).toBe(true);expect(keys.join()).not.toContain(runPhantom.dbPath);
  mkdirSync(evidence,{recursive:true});await page.getByRole("button",{name:"Remove Captured cost (USD) equals 0",exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,"desktop-typed-controls.png"),fullPage:true});
  await page.getByRole("button",{name:"Advanced filters",exact:true}).click();await page.screenshot({path:path.join(evidence,"desktop-typed-span-hits.png"),fullPage:true});
});

test("secret queries preserve search meaning while skipping recent storage and mobile remains usable",async({page,request,runPhantom})=>{
  await seed(request,runPhantom.url);await page.setViewportSize({width:390,height:844});await page.goto(runPhantom.url+"/search");
  await page.getByRole("button",{name:"Advanced filters",exact:true}).click();
  const query=page.getByLabel("Search captured runs",{exact:true}), secret="sk-proj-"+"Q7".repeat(35);
  await query.fill(secret);await expect(page.getByText("No matching runs",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Save search",exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain(secret);
  await query.fill("literal%_東京");await page.getByLabel("Filter field",{exact:true}).selectOption("tag");await page.getByLabel("Filter value",{exact:true}).fill("東京%_");
  await expect(page.locator('datalist option[value="東京%_"]')).toHaveCount(1);await page.getByLabel("Filter value",{exact:true}).press("Enter");await expect(page.getByRole("button",{name:"Remove Tag equals 東京%_",exact:true})).toBeVisible();
  await page.getByLabel("Search result type",{exact:true}).selectOption("span-hits");
  await expect(page.locator("[data-span-hit]")).toHaveCount(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,"mobile-typed-span-hits.png"),fullPage:true});
});
