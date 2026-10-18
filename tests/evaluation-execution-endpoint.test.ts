import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { parseExecutionPolicy, readExecutionPolicyFile, readExecutionResponse } from "../src/evaluations/execution-endpoint";
const directories: string[] = []; afterEach(() => { for (const p of directories.splice(0)) rmSync(p,{ recursive:true,force:true }); });
const policy = () => ({ version:1, enabled:true, endpoints:[{ endpointName:"native", revision:"1", enabled:true, costAccount:"free-fixture", costMode:"free_local",
  maximumAttemptMicrousd:0,maximumTotalMicrousd:0,maximumOutputTokens:256,maximumIterations:1 }] });
test("native policy is disabled by absence and imported URLs/paid quotes confer no authority", () => {
  expect(parseExecutionPolicy(null)).toEqual({ version:1,enabled:false,endpoints:[] });
  expect(() => parseExecutionPolicy({ ...policy(), url:"http://127.0.0.1:1" })).toThrow();
  expect(() => parseExecutionPolicy({ ...policy(), endpoints:[{...policy().endpoints[0],maximumAttemptMicrousd:1}] })).toThrow();
});
test("native policy requires an owned private regular nonsymlink file and bounded fields", () => {
  const dir=mkdtempSync(path.join(tmpdir(),"rp-execution-policy-")); directories.push(dir); chmodSync(dir,0o700);
  const file=path.join(dir,"policy.json"); writeFileSync(file,JSON.stringify(policy()),{mode:0o600});
  expect(readExecutionPolicyFile(file).policy.endpoints).toHaveLength(1);
  const alias=path.join(dir,"alias.json");symlinkSync(file,alias);expect(() => readExecutionPolicyFile(alias)).toThrow();
  chmodSync(file,0o666);expect(() => readExecutionPolicyFile(file)).toThrow();chmodSync(file,0o600);
  writeFileSync(file," ".repeat(65537));expect(() => readExecutionPolicyFile(file)).toThrow();
});
test("actual private HTTP200 is only transport success; malformed/oversize/declared error stays unavailable or failed", async () => {
  const server=http.createServer((req,res) => { res.setHeader("content-type","application/json");
    if(req.url==="/malformed")res.end("{");else if(req.url==="/huge")res.end("x".repeat(65537));else if(req.url==="/failure")res.end('{"status":"failed","error":"private raw reason"}');else res.end('{"status":"completed","runId":"forged-body-run","actualCostUsd":0}'); });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("fixture");
  try { const read=async (route:string) => readExecutionResponse(await fetch(`http://127.0.0.1:${address.port}${route}`));
    expect(await read("/ok")).toEqual({status:"transport_success",runId:null,actualCostUsd:null});
    expect((await read("/failure")).status).toBe("failed");expect((await read("/malformed")).status).toBe("unavailable");expect((await read("/huge")).status).toBe("unavailable");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test("fresh private native HOME uses registered endpoint/policy, frozen identity, and rechecks revocation before dispatch", async () => {
  const directory=mkdtempSync(path.join(tmpdir(),"rp-native-execution-control-")); directories.push(directory); chmodSync(directory,0o700);
  const bodies: Array<Record<string,unknown>>=[];
  const server=http.createServer(async(req,res)=>{let body="";for await(const chunk of req)body+=chunk.toString();bodies.push(JSON.parse(body));res.end('{"status":"completed","runId":"forged-body-run","actualCostUsd":0}');});
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("fixture");
  const { spawn }=await import("node:child_process");
  try {
    const script=path.resolve(import.meta.dir,"fixtures/execution-endpoint-control.ts");
    const child=spawn(process.execPath,[script,String(address.port)],{cwd:path.resolve(import.meta.dir,".."),env:{HOME:directory,PATH:process.env.PATH,RUNPHANTOM_DB_PATH:path.join(directory,"isolated.db")},stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";child.stdout.on("data",chunk=>stdout+=chunk.toString());child.stderr.on("data",chunk=>stderr+=chunk.toString());
    const [code]=await once(child,"exit");expect(stderr).toBe("");expect(code).toBe(0);
    const result=JSON.parse(stdout);expect(result.afterRevocation.status).toBe("unavailable");expect(result.paidRefused).toBe(true);expect(result.execution.cases).toHaveLength(1);
    expect(result.execution.cases[0].attempts[0].status).toBe("transport_success");expect(result.execution.cases[0].grading.status).toBe("inconclusive");
    expect(bodies).toHaveLength(1);expect(bodies[0].executionId).toBe(result.execution.id);expect(bodies[0].userMessage).toBe("$& ${literal} <img src=x>");
    expect(bodies[0].replayRunId).toBe(result.execution.cases[0].attempts[0].id);expect(JSON.stringify(result.execution)).not.toContain("forged-body-run");
  } finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
