import type { AdapterInput, AdapterMatch, SpanAdapter } from "./types";
import { parseBoundedHookJson, type HookJson } from "../../coding-hooks/shared";

export interface ClaudeHookCaptureViewV1 {
 contract:"runphantom.claude-hook.observation/v1";
 entityKind:"session"|"prompt"|"tool"|"assistant"|"subagent";
 sourceKind:"hook"|"transcript";
 coverage:"partial";producerVerified:false;runtimeVerified:false;
 reportedPhase:"pending"|"success"|"failure"|"interrupted"|"complete"|"unknown"|"conflict";
 reportedDurationMs:number|null;
 usage:{freshInputTokens:number|null;outputTokens:number|null;cacheCreatedInputTokens:number|null;cacheReadInputTokens:number|null}|null;
 userText:string|null;assistantText:string|null;
}
export interface ClaudeHookCaptureViewV2 extends Omit<ClaudeHookCaptureViewV1,"contract"> {
 contract:"runphantom.claude-hook.observation/v2";
 contextKey:string|null;contextRevision:number|null;sessionContextVersion:2|null;retainedSessionSha256:string|null;
}
export type ClaudeHookCaptureView = ClaudeHookCaptureViewV1 | ClaudeHookCaptureViewV2;
export const CLAUDE_HOOK_CAPTURE_CONTRACT="runphantom.claude-hook.observation/v1";
const contract=CLAUDE_HOOK_CAPTURE_CONTRACT;
const contextContract="runphantom.claude-hook.observation/v2";
const keys="captureContract,captureModel,coverage,coverageReasons,currentCapturePolicy,entityKind,producerVerified,reportedDurationMs,reportedPhase,retainedBody,retainedEntitySha256,runtimeVerified,source,sourceKind,usage";
const isEntityKind=(value:unknown):value is ClaudeHookCaptureView["entityKind"]=>typeof value==="string"&&["session","prompt","tool","assistant","subagent"].includes(value);
const isPhase=(value:unknown):value is ClaudeHookCaptureView["reportedPhase"]=>typeof value==="string"&&phases.includes(value);
const types={session:"AGENT_ROOT",prompt:"INTERNAL",tool:"TOOL_CALL",assistant:"LLM_GENERATION",subagent:"INTERNAL"} as const;
// Closed read contract mirrors the admitted producer coverage vocabulary.
const coverageReasons = new Set(["producer_unverified", "unknown_fields", "transcript_absent", "unresolved_prompt_identity", "unresolved_assistant_identity", "unresolved_subagent_linkage", "tool_output_absent", "terminal_regression", "contradictory_terminal_claims", "assistant_fragments_unmerged", "inconsistent_request_identity", "inconsistent_model_identity", "invalid_timestamp", "invalid_usage", "invalid_record", "unsupported_version", "unsupported_record", "unsupported_content", "transcript_version_absent", "incomplete_tail", "parse_deadline", "record_limit", "line_limit", "entity_limit", "body_partial", "body_redacted", "body_limit", "model_limit", "invalid_json", "byte_limit", "depth_limit", "node_limit", "duplicate_keys", "invalid_number", "unsafe_key", "invalid_fields", "field_limit", "unsupported_event", "source_changed", "source_unavailable", "path_not_authorized", "not_regular_file", "file_limit", "identity_unavailable", "invalid_utf8", "aborted", "deadline"]);
const phases=["pending","success","failure","interrupted","complete","unknown","conflict"];
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const count=(v:unknown):v is number|null=>v===null||typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
function payload(value:string|undefined):{ok:true;value:HookJson}|{ok:false} {
 if(value===undefined)return {ok:true,value:null};
 const parsed=parseBoundedHookJson(value,16384);return parsed.status==="accepted"?{ok:true,value:parsed.value}:{ok:false};
}
function text(value:HookJson, toolUse=false):string|null|undefined {
 if(typeof value==="string")return value;
 if(value===null)return null;
 if(!Array.isArray(value))return undefined;
 const parts:string[]=[];
 for(const part of value){
  if(!object(part))return undefined;
  if(part.type==="text"&&Object.keys(part).sort().join() === "text,type"&&typeof part.text==="string")parts.push(part.text);
  else if(toolUse&&part.type==="tool_use"&&Object.keys(part).sort().join()==="input,name,toolIdentity,type"&&typeof part.toolIdentity==="string"&&/^[a-f0-9]{64}$/.test(part.toolIdentity)&&typeof part.name==="string"&&part.name.length<=256)continue;
  else return undefined;
 }
 return parts.length?parts.join(""):null;
}
/** Read interpretation only: a matching attribute never authenticates a producer or grants policy. */
export const claudeHookAdapter:SpanAdapter={name:"claude-hook-observation",apply(input:AdapterInput):AdapterMatch|null {
 const raw:unknown=input.attrs;if(!object(raw)||typeof raw.captureContract!=="string"||!raw.captureContract.startsWith("runphantom.claude-hook.observation/"))return null;
 // Matching malformed source data never falls through to an SDK/GenAI guess.
 const unknown=()=>({normalized:{kind:"other" as const}});
 if(raw.captureContract!==contract&&raw.captureContract!==contextContract)return unknown();
 const v2=raw.captureContract===contextContract;
 const bounded=parseBoundedHookJson(JSON.stringify(raw),16384);if(bounded.status!=="accepted"||!object(bounded.value))return unknown();const a=bounded.value;
 if(Object.keys(a).sort().join()!==(v2?[...keys.split(","),"contextKey","contextRevision","sessionContextVersion","retainedSessionSha256"].sort().join():keys)||a.source!=="claude_hook"||a.producerVerified!==false||a.runtimeVerified!==false||a.coverage!=="partial"
  ||!isEntityKind(a.entityKind)||types[a.entityKind]!==input.spanType
  ||(a.sourceKind!=="hook"&&a.sourceKind!=="transcript")||!isPhase(a.reportedPhase)
  ||!(a.reportedDurationMs===null||typeof a.reportedDurationMs==="number"&&Number.isFinite(a.reportedDurationMs)&&a.reportedDurationMs>=0&&a.reportedDurationMs<=Number.MAX_SAFE_INTEGER)
  ||!(a.captureModel===null||typeof a.captureModel==="string"&&a.captureModel.length<=256)
  ||!Array.isArray(a.coverageReasons)||a.coverageReasons.length>64||a.coverageReasons.some(x=>typeof x!=="string"||!coverageReasons.has(x))
  ||(a.currentCapturePolicy!=="metadata"&&a.currentCapturePolicy!=="full")||typeof a.retainedBody!=="boolean"||typeof a.retainedEntitySha256!=="string"||!/^[a-f0-9]{64}$/.test(a.retainedEntitySha256))return unknown();
 let usage:ClaudeHookCaptureView["usage"]=null;
 if(a.usage!==null){if(!object(a.usage)||Object.keys(a.usage).sort().join()!=="cacheCreatedInputTokens,cacheReadInputTokens,freshInputTokens,outputTokens"||!count(a.usage.freshInputTokens)||!count(a.usage.outputTokens)||!count(a.usage.cacheCreatedInputTokens)||!count(a.usage.cacheReadInputTokens))return unknown();usage={freshInputTokens:a.usage.freshInputTokens,outputTokens:a.usage.outputTokens,cacheCreatedInputTokens:a.usage.cacheCreatedInputTokens,cacheReadInputTokens:a.usage.cacheReadInputTokens};}
 if(v2){
  const hex=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
  if(a.sourceKind==="transcript"?!hex(a.contextKey)||typeof a.contextRevision!=="number"||!Number.isSafeInteger(a.contextRevision)||a.contextRevision<1||a.contextRevision>999999:a.contextKey!==null||a.contextRevision!==null)return unknown();
  if(a.entityKind==="session"?a.sessionContextVersion!==2||!hex(a.retainedSessionSha256):a.sessionContextVersion!==null||a.retainedSessionSha256!==null)return unknown();
 }
 const incoming=payload(input.inputPayload),outgoing=payload(input.outputPayload);if(!incoming.ok||!outgoing.ok)return unknown();
 if(!a.retainedBody&&(incoming.value!==null||outgoing.value!==null)||typeof input.spanName!=="string"||input.spanName.length>256)return unknown();
 if((["prompt","assistant"].includes(a.entityKind)&&a.sourceKind!=="transcript")||(["session","subagent"].includes(a.entityKind)&&a.sourceKind!=="hook")||a.entityKind!=="assistant"&&a.captureModel!==null)return unknown();
 if(a.entityKind==="assistant"&&incoming.value!==null||a.entityKind==="prompt"&&outgoing.value!==null||["session","subagent"].includes(a.entityKind)&&(incoming.value!==null||outgoing.value!==null)||a.entityKind!=="assistant"&&a.usage!==null)return unknown();
 const userText=a.entityKind==="prompt"?text(incoming.value):null,assistantText=a.entityKind==="assistant"?text(outgoing.value,true):null;
 if(userText===undefined||assistantText===undefined||a.entityKind==="assistant"&&outgoing.value!==null&&!Array.isArray(outgoing.value))return unknown();
 const base:Omit<ClaudeHookCaptureViewV1,"contract">={entityKind:a.entityKind,sourceKind:a.sourceKind,coverage:"partial",producerVerified:false,runtimeVerified:false,reportedPhase:a.reportedPhase,reportedDurationMs:a.reportedDurationMs,usage,userText,assistantText};
 let capture:ClaudeHookCaptureView;
 if(v2){
  if(!(a.contextKey===null||typeof a.contextKey==="string")||!(a.contextRevision===null||typeof a.contextRevision==="number")||!(a.sessionContextVersion===null||a.sessionContextVersion===2)||!(a.retainedSessionSha256===null||typeof a.retainedSessionSha256==="string"))return unknown();
  capture={contract:contextContract,...base,contextKey:a.contextKey,contextRevision:a.contextRevision,sessionContextVersion:a.sessionContextVersion,retainedSessionSha256:a.retainedSessionSha256};
 }else capture={contract,...base};
 if(a.entityKind==="tool")return {normalized:{kind:"tool",name:input.spanName,args:incoming.value,result:outgoing.value,resultIsError:["failure","interrupted","conflict"].includes(capture.reportedPhase),capture}};
 if(a.entityKind==="assistant")return {normalized:{kind:"llm",messages:[],userMessage:"",systemPrompt:"",...(typeof a.captureModel==="string"?{model:a.captureModel}:{}),capture}};
 return {normalized:{kind:"other",capture}};
}};
