import type { NormalizedClaudeEntity } from "./claude";
import type { HookAdmission } from "./store";
import { hookDigest } from "./protocol";

export const CLAUDE_CAPTURE_CONTRACT = "runphantom.claude-hook.observation/v1";
const TYPES = Object.freeze({tool:"TOOL_CALL",assistant:"LLM_GENERATION",session:"AGENT_ROOT",prompt:"INTERNAL",subagent:"INTERNAL"} as const);
/** Receives a completely validated, witness-bound NEXT DTO; grants no authority. */
export function claudeEntityProjection(next: NormalizedClaudeEntity, session: Pick<HookAdmission,"runId"|"rootSpanId">, captureMode:"metadata"|"full", retained:string) {
 const id=next.kind==="session"?session.rootSpanId:next.entityKey.slice(0,16);
 return {
  id,run_id:session.runId,parent_span_id:next.kind==="session"?null:session.rootSpanId,name:next.name,span_type:TYPES[next.kind],
  status:next.kind==="session"?"UNSET":["failure","interrupted","conflict"].includes(next.phase)?"ERROR":next.phase==="success"?"OK":"UNSET",
  input_payload:next.body?.input===null||!next.body?null:JSON.stringify(next.body.input),output_payload:next.body?.output===null||!next.body?null:JSON.stringify(next.body.output),
  start_time_ms:next.reportedAt===null?null:Date.parse(next.reportedAt),end_time_ms:null,duration_ms:null,model:next.model,provider:"anthropic",input_tokens:next.usage?.freshInputTokens??null,output_tokens:next.usage?.outputTokens??null,
  attributes:JSON.stringify({source:"claude_hook",producerVerified:false,runtimeVerified:false,coverage:"partial",coverageReasons:next.coverageReasons,reportedPhase:next.phase,reportedDurationMs:next.reportedDurationMs,usage:next.usage,currentCapturePolicy:captureMode,retainedBody:next.body!==null,retainedEntitySha256:hookDigest(retained),captureContract:CLAUDE_CAPTURE_CONTRACT,entityKind:next.kind,sourceKind:next.sourceKind,captureModel:next.model}),otlp_evidence:null
 };
}
