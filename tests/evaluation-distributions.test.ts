import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { createEvaluationRouter } from "../src/evaluations/router";
import { createEvaluationService } from "../src/evaluations/service";
import { closeDb, getDrizzleDb } from "../src/db";
import { snapshotRun } from "../src/evaluations/snapshot";
import { analyzeScoreDistribution, parseDistributionRequest } from "../src/evaluations/distributions";
import { readDistributionSelection, readExperimentSelection, insertExperiment } from "../src/evaluations/store";
import { canonicalCaseDefinitions } from "../src/evaluations/validation";
import { evaluateRule } from "../src/evaluations/rules";
import type { Experiment, DatasetCase } from "../src/evaluations/protocol";
import type { DistributionRequest } from "../src/evaluations/aggregation-protocol";

export function distributionExperiment(id: string, scores: Array<number | null> = [1, 0]): Experiment {
  const results = scores.map((score, index) => {
    const runId = `${id}-run-${index}`;
    const snapshot = snapshotRun({ id: runId, name: "private name" }, [{ id: "root", run_id: runId, name: "agent", span_type: "AGENT_ROOT", status: "OK", input_payload: "private-input", output_payload: "private-output", attributes: "{}", start_time_ms: 1, end_time_ms: 2 }]);
    const item: DatasetCase = { id: `case-${index}`, name: `Case ${index}`, input: "private-input", sourceRunId: null, sourceSpanId: null, sourceOutput: "private-source-output", tags: [], rules: [{ kind: "output", operation: "equals", value: "private-output" }], sourceCapturedAt: null, sourceRedacted: false, sourceTruncated: false, sourceSnapshotVersion: null };
    const check = evaluateRule(item.rules[0], snapshot);check.score=score;check.reason="private-explanation";
    return { caseId: item.id, caseName: item.name, runId, inputMatch: "match" as const, status: "pass" as const, checks: [check], snapshot, case: item };
  });
  return { id, name: "private-experiment-name", evaluationVersion: 1, snapshotVersion: 1, datasetId: "dataset", datasetName: "private-dataset-name", datasetVersion: 2,
    datasetHash: createHash("sha256").update(canonicalCaseDefinitions(results.map(result => result.case))).digest("hex"), status: "completed", verdict: "pass", createdAt: 1, completedAt: 2, results,
    summary: { total: scores.length, pass: scores.length, fail: 0, inconclusive: 0, passRate: 1 }, error: null };
}
const request = (ids: string[], extra: Partial<DistributionRequest> = {}): DistributionRequest => ({ experimentIds: ids, selector: { kind: "check_score", caseId: "case-0", ruleIndex: 0 }, direction: "none", bins: 10, ...extra });
const analyze = (experiments: Experiment[], extra: Partial<DistributionRequest> = {}) => analyzeScoreDistribution(request(experiments.map(item => item.id),extra),(_ids,consume)=>experiments.forEach(consume));

describe("closed score populations",()=>{
  test("one exact check meaning keeps finite zero, exclusions and immutable machine verdicts",()=>{
    const a=distributionExperiment("a",[0,1]), b=distributionExperiment("b",[.5,0]), c=distributionExperiment("c",[null,1]);c.status="cancelled";c.verdict="inconclusive";
    const frozen=JSON.stringify([a,b,c]);const result=analyze([a,b,c]);
    expect(result.overall).toMatchObject({population:{total:3,finite:2,excluded:1,zero:1},mean:.25,median:.25,min:0,max:.5});
    expect(result.experiments.map(item=>item.stats.population.total)).toEqual([1,1,1]);
    expect(result.trend[0]).toMatchObject({delta:.5,change:"higher",preference:null});
    expect(result.trend[1]).toMatchObject({delta:null,deltaUnavailable:"empty",preference:null});
    expect(result.experiments[2]).toMatchObject({status:"cancelled",verdict:"inconclusive"});
    expect(JSON.stringify([a,b,c])).toBe(frozen);
    const text=JSON.stringify(result);for(const privateValue of ["private-input","private-output","private-source-output","private-explanation",a.datasetHash,"private-experiment-name","private-dataset-name"])expect(text).not.toContain(privateValue);
  });
  test("preferences describe chosen numeric direction, including none on equal means",()=>{
    const a=distributionExperiment("a",[.2]),b=distributionExperiment("b",[.8]);
    expect(analyze([a,b],{direction:"higher"}).trend[0].preference).toBe("improved");
    expect(analyze([a,b],{direction:"lower"}).trend[0].preference).toBe("regressed");
    b.results[0].checks[0].score=.2;
    expect(analyze([a,b]).trend[0].preference).toBeNull();
    expect(analyze([a,b],{direction:"higher"}).trend[0].preference).toBe("unchanged");
    expect(analyze([a]).trend).toEqual([]);
  });
  test("invalid score scales and withheld values are excluded without coercion",()=>{
    for(const score of [-1,1.01,Infinity,NaN,"0",false] as unknown[]){const value=distributionExperiment("a");(value.results[0].checks[0] as unknown as Record<string,unknown>).score=score;expect(analyze([value]).overall).toMatchObject({population:{finite:0,excluded:1},mean:null,sum:null,histogram:[]});}
    for(const flag of ["redacted","truncated"] as const){const value=distributionExperiment("a");value.results[0].checks[0][flag]=true;expect(analyze([value]).overall.population.excluded).toBe(1);}
  });
  test("captured metrics use every compatible case, with safe unit domains and honest overflow",()=>{
    const a=distributionExperiment("a"), b=distributionExperiment("b");
    a.results[0].snapshot.metrics.totalTokens=0;a.results[1].snapshot.metrics.totalTokens=10;b.results[0].snapshot.metrics.totalTokens=null;b.results[1].snapshot.metrics.totalTokens=Number.MAX_SAFE_INTEGER+1;
    const selected={kind:"snapshot_metric",metric:"totalTokens"} as const;
    expect(analyze([a,b],{selector:selected})).toMatchObject({unit:"tokens",overall:{population:{total:4,finite:2,excluded:2,zero:1},sum:10,mean:5}});
    for(const metric of ["inputTokens","outputTokens","totalTokens","toolCalls"] as const){for(const invalid of [-1,1.5,Number.MAX_SAFE_INTEGER+1]){a.results[0].snapshot.metrics[metric]=invalid;a.results[1].snapshot.metrics[metric]=null;expect(analyze([a],{selector:{kind:"snapshot_metric",metric}}).overall.population.excluded).toBe(2);}}
    a.results.forEach(item=>item.snapshot.metrics.durationMs=Number.MAX_VALUE);
    expect(analyze([a],{selector:{kind:"snapshot_metric",metric:"durationMs"}})).toMatchObject({unit:"ms",overall:{mean:Number.MAX_VALUE,sum:null,sumUnavailable:"overflow"}});
    a.results[0].snapshot.metrics.costUsd=0;a.results[1].snapshot.metrics.costUsd=-1;
    expect(analyze([a],{selector:{kind:"snapshot_metric",metric:"costUsd"}})).toMatchObject({unit:"USD",overall:{population:{finite:1,excluded:1,zero:1}}});
  });
  test("full frozen membership and rule/evaluator identity refuse incomplete or altered rows",()=>{
    for(const mutate of [(x:Experiment)=>{x.results.pop();},(x:Experiment)=>{x.results.pop();x.summary.total=1;},(x:Experiment)=>{x.results[0].case.rules[0]={kind:"json"};},(x:Experiment)=>{x.results[0].checks[0].evaluatorVersion="code:old";},(x:Experiment)=>{x.datasetId="other";},(x:Experiment)=>{x.datasetVersion=3;},(x:Experiment)=>{x.results[0].snapshot.version=2 as 1;},(x:Experiment)=>{x.results[0].checks=[];},(x:Experiment)=>{x.status="running";},(x:Experiment)=>{x.results[1]=x.results[0];}]){
      const b=distributionExperiment("b");mutate(b);expect(()=>analyze([distributionExperiment("a"),b])).toThrow();
    }
    expect(()=>analyze([distributionExperiment("a")],{selector:{kind:"check_score",caseId:"absent",ruleIndex:0}})).toThrow("absent");
    const ids=["b","a"];const result=analyzeScoreDistribution(request(ids),(_ids,consume)=>[distributionExperiment("a"),distributionExperiment("b")].forEach(consume));expect(result.experiments.map(item=>item.experimentId)).toEqual(ids);
    expect(()=>analyzeScoreDistribution(request(ids),(_ids,consume)=>consume(distributionExperiment("a")))).toThrow("not found");
  });
  test("closed request rejects unsupported capabilities, duplicate IDs and accessors",()=>{
    for(const value of [{...request(["a"]),path:"private"},{...request(["a"]),selector:{kind:"snapshot_metric",metric:"toString"}},{...request(["a"]),selector:{kind:"check_score",caseId:"case-0",ruleIndex:8}},{...request(["a"]),direction:"auto"},{...request(["a"]),bins:0},request([]),request(["a","a"]),request(Array.from({length:21},(_,i)=>String(i)))])expect(()=>parseDistributionRequest(value)).toThrow();
    let reads=0;const value=request(["a"]);Object.defineProperty(value,"direction",{get(){reads++;return "none";}});expect(()=>parseDistributionRequest(value)).toThrow("accessors");expect(reads).toBe(0);
    const ids=["a"];Object.defineProperty(ids,"0",{get(){reads++;return "a";}});expect(()=>parseDistributionRequest(request(ids))).toThrow("accessors");expect(reads).toBe(0);
  });
});

describe("bounded frozen distribution storage",()=>{
  let directory:string, oldDb:string|undefined;
  beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),"rp-distribution-"));oldDb=process.env.RUNPHANTOM_DB_PATH;closeDb();process.env.RUNPHANTOM_DB_PATH=join(directory,"data.db");});
  afterEach(()=>{closeDb();if(oldDb===undefined)delete process.env.RUNPHANTOM_DB_PATH;else process.env.RUNPHANTOM_DB_PATH=oldDb;rmSync(directory,{recursive:true,force:true});});
  test("one retained row survives reopen without datasets or runs while trial minimum stays two",()=>{
    insertExperiment(distributionExperiment("a"),"token");const first=analyzeScoreDistribution(request(["a"]),readDistributionSelection);closeDb();
    expect(analyzeScoreDistribution(request(["a"]),readDistributionSelection)).toEqual(first);
    expect(()=>readExperimentSelection(["a"],()=>{})).toThrow("at least two");
    expect(()=>readDistributionSelection(["gone"],()=>{})).toThrow("not found");
  });
  test("aggregate and individual UTF8 bounds precede materialization and JSON parsing",()=>{
    for(const id of ["a","b","c"])insertExperiment(distributionExperiment(id),id);
    const db=getDrizzleDb().$client;
    for(const [ids,bytes,expected] of [[ ["a"],4*1024*1024+1,"4 MiB"],[["a","b","c"],Math.ceil(8*1024*1024/3),"8 MiB"]] as const){
      const invalid="界".repeat(Math.ceil(bytes/3));db.query("UPDATE evaluation_experiments SET data=?").run(invalid);
      const parse=spyOn(JSON,"parse");let consumed=0;
      try{expect(()=>readDistributionSelection([...ids],()=>{consumed++;})).toThrow(expected);expect(parse).not.toHaveBeenCalled();expect(consumed).toBe(0);}finally{parse.mockRestore();}
    }
  });
  test("actual HTTP reads the frozen population, refuses incompatible data and survives database reopen",async()=>{
    const a=distributionExperiment("a",[0,1]), b=distributionExperiment("b",[1,0]);
    insertExperiment(a,"a");insertExperiment(b,"b");
    const service=createEvaluationService({judge:async()=>{throw new Error("Analysis must never execute a judge");}});
    const app=express();app.use(express.json());app.use("/api/evaluations",createEvaluationRouter(service));
    const server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/evaluations/analyses/score-distributions`;
    const post=(body:unknown)=>fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    try{
      const before=getDrizzleDb().$client.query("SELECT * FROM evaluation_experiments ORDER BY id").all();
      const first=await post(request(["a","b"],{direction:"higher"}));expect(first.status).toBe(200);expect(first.headers.get("cache-control")).toBe("no-store");
      const analysis=await first.json();expect(analysis.overall).toMatchObject({mean:.5,population:{total:2,finite:2,zero:1}});expect(analysis.trend[0]).toMatchObject({delta:1,preference:"improved"});
      expect(getDrizzleDb().$client.query("SELECT * FROM evaluation_experiments ORDER BY id").all()).toEqual(before);
      closeDb();expect(await (await post(request(["a","b"],{direction:"higher"}))).json()).toEqual(analysis);
      expect((await post(request(["gone"]))).status).toBe(404);expect((await post({...request(["a"]),prompt:"private"})).status).toBe(400);
      b.results[0].checks[0].evaluatorVersion="other";getDrizzleDb().$client.query("UPDATE evaluation_experiments SET data=? WHERE id='b'").run(JSON.stringify(b));
      expect((await post(request(["a","b"]))).status).toBe(409);
      getDrizzleDb().$client.query("UPDATE evaluation_experiments SET data=? WHERE id='a'").run("界".repeat(Math.ceil((4*1024*1024+1)/3)));
      expect((await post(request(["a"]))).status).toBe(413);
      expect(JSON.stringify(analysis)).not.toContain("private-");expect(JSON.stringify(analysis)).not.toContain(a.datasetHash);
    }finally{service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
