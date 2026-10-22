import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getAgentEndpoint, _internal as agentConfig } from "../agents-config";
import { object, fields, parseId, EvaluationError } from "./validation";
import { EXECUTION_LIMITS as L, type DispatchResult } from "./execution-protocol";
import type { EndpointDispatch } from "./executor";

export interface NativeExecutionEndpointPolicy {
  endpointName: string; revision: string; enabled: boolean; costAccount: string; costMode: "free_local" | "guarded_paid";
  maximumAttemptMicrousd: number; maximumTotalMicrousd: number; maximumOutputTokens: number; maximumIterations: number;
}
export interface NativeExecutionPolicy { version: 1; enabled: boolean; endpoints: NativeExecutionEndpointPolicy[] }
const disabled = (): NativeExecutionPolicy => ({ version: 1, enabled: false, endpoints: [] });
function finite(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new EvaluationError("Native execution policy limit is invalid");
  return value;
}
export function parseExecutionPolicy(body: unknown): NativeExecutionPolicy {
  if (body === null) return disabled();
  const input = object(body); fields(input,["version","enabled","endpoints"]);
  if (input.version !== 1 || typeof input.enabled !== "boolean" || !Array.isArray(input.endpoints) || input.endpoints.length > 20) throw new EvaluationError("Native execution policy is invalid");
  const seen = new Set<string>();
  const endpoints = Array.from(input.endpoints, raw => {
    const value = object(raw); fields(value,["endpointName","revision","enabled","costAccount","costMode","maximumAttemptMicrousd","maximumTotalMicrousd","maximumOutputTokens","maximumIterations"]);
    const endpointName = parseId(value.endpointName);
    if (seen.has(endpointName) || typeof value.enabled !== "boolean" || (typeof value.costMode !== "string" || !["free_local","guarded_paid"].includes(value.costMode))) throw new EvaluationError("Native endpoint policy is invalid");
    seen.add(endpointName);
    const endpoint: NativeExecutionEndpointPolicy = { endpointName, revision: parseId(value.revision), enabled: value.enabled, costAccount: parseId(value.costAccount), costMode: value.costMode as "free_local" | "guarded_paid",
      maximumAttemptMicrousd: finite(value.maximumAttemptMicrousd,30_000_000), maximumTotalMicrousd: finite(value.maximumTotalMicrousd,30_000_000), maximumOutputTokens: finite(value.maximumOutputTokens,4096), maximumIterations: finite(value.maximumIterations,20) };
    if (!endpoint.maximumOutputTokens || !endpoint.maximumIterations || (endpoint.costMode === "free_local" && (endpoint.maximumAttemptMicrousd !== 0 || endpoint.maximumTotalMicrousd !== 0))) throw new EvaluationError("Free local policy cannot authorize paid work");
    return endpoint;
  });
  return { version:1,enabled:input.enabled,endpoints };
}
/** Path is native owner construction / private test plumbing, never an HTTP request field. */
export function readExecutionPolicyFile(file: string): { policy: NativeExecutionPolicy; digest: string } {
  if (!fs.existsSync(file)) { const policy=disabled(); return { policy,digest:createHash("sha256").update(JSON.stringify(policy)).digest("hex") }; }
  const uid=process.getuid?.(), parent=fs.lstatSync(path.dirname(file)), before=fs.lstatSync(file);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !before.isFile() || before.isSymbolicLink() || uid===undefined || before.uid!==uid || parent.uid!==uid ||
    (before.mode & 0o077)!==0 || (parent.mode & 0o022)!==0 || before.size>L.MAX_RESPONSE_BYTES) throw new EvaluationError("Native execution policy file is unavailable",403);
  const fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const current=fs.fstatSync(fd);
    if (!current.isFile() || current.dev!==before.dev || current.ino!==before.ino || current.uid!==uid || (current.mode & 0o077)!==0 || current.size>L.MAX_RESPONSE_BYTES) throw new EvaluationError("Native execution policy authority changed",409);
    const bytes=Buffer.alloc(current.size), count=fs.readSync(fd,bytes,0,bytes.length,0);
    if(count!==current.size || fs.fstatSync(fd).size!==current.size)throw new EvaluationError("Native execution policy changed while reading",409);
    const policy=parseExecutionPolicy(JSON.parse(bytes.toString("utf8")));
    return { policy,digest:createHash("sha256").update(JSON.stringify(policy)).digest("hex") };
  } finally { fs.closeSync(fd); }
}
const policyPath = () => path.join(os.homedir(),".runphantom","dataset-execution-policy.json");
export function nativeExecutionPolicy() { return readExecutionPolicyFile(policyPath()); }

/** Finite response metadata only; no returned run identity, price, arbitrary body or raw error is authority. */
export async function readExecutionResponse(response: Response): Promise<DispatchResult> {
  const unavailable: DispatchResult={ status:"unavailable",runId:null,actualCostUsd:null };
  if (!response.ok) { await response.body?.cancel().catch(()=>{}); return { ...unavailable,status:"failed" }; }
  if (!response.body || Number(response.headers.get("content-length"))>L.MAX_RESPONSE_BYTES) { await response.body?.cancel().catch(()=>{});return unavailable; }
  const reader=response.body.getReader(), chunks:Uint8Array[]=[];let size=0;
  try {
    while(true) { const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>L.MAX_RESPONSE_BYTES){await reader.cancel();return unavailable;}chunks.push(value); }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const body=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
    return { ...unavailable,status:body.error || ["error","failed"].includes(String(body.status).toLowerCase()) ? "failed" : "transport_success" };
  } catch { await reader.cancel().catch(()=>{});return unavailable; }
}

/** Production resolver is closed over native registration. It neither discovers nor launches commands. */
export function registeredExecutionDispatcher(endpointName: string, executionId: string): { dispatch: EndpointDispatch; policy: NativeExecutionEndpointPolicy; policyDigest: string } {
  parseId(executionId);
  const admission=nativeExecutionPolicy(), policy=admission.policy.endpoints.find(item=>item.endpointName===endpointName);
  const registered=getAgentEndpoint(endpointName), url=agentConfig.normalizeLoopbackHttpUrl(registered?.url);
  if (!admission.policy.enabled || !policy?.enabled || !url) throw new EvaluationError("Registered execution endpoint is unavailable",409);
  if(policy.costMode!=="free_local")throw new EvaluationError("Paid endpoint budget enforcement is unavailable",409);
  const dispatch:EndpointDispatch=async(request,item,attempt,signal)=>{
    const current=nativeExecutionPolicy(), source=getAgentEndpoint(endpointName), currentUrl=agentConfig.normalizeLoopbackHttpUrl(source?.url);
    if(current.digest!==admission.digest || currentUrl!==url || request.endpointName!==endpointName) return {status:"unavailable",runId:null,actualCostUsd:null};
    const response=await fetch(url,{method:"POST",redirect:"error",signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({
      replayRunId:attempt.id,executionId,caseId:item.case.id,userMessage:item.case.input,
      messages:[{role:"user",content:item.case.input}],datasetExecution:{version:1,caseId:item.case.id,attemptId:attempt.id,attemptIndex:attempt.index,
        maximumOutputTokens:policy.maximumOutputTokens,maximumIterations:policy.maximumIterations,maximumCostMicrousd:0},
    })});
    return readExecutionResponse(response);
  };
  return {dispatch,policy:{...policy},policyDigest:admission.digest};
}
