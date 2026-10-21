import type { NormalizedClaudeBatch, NormalizedClaudeEntity } from "./claude";
import { sanitizeClaudeRetention } from "./claude";
import { CLAUDE_HOOK_EVENTS, parseBoundedHookJson, type HookJson } from "./shared";
import { boundedInteger, type CompleteSessionRow } from "./retained-version";
import { hookDigest, isHex, refuse, validCoverageReasons, validateClaudeRetainedEntity } from "./protocol";
import type { HookSourceClaims } from "./protocol";

export const CONTEXT_CAPTURE_CONTRACT = "runphantom.claude-hook.observation/v2";
export const CONTEXT_CATALOG_VERSION = "runphantom.claude-catalog/v2";
export const CONTEXT_LIMITS = Object.freeze({ contexts:32, revision:999999, sessionData:12288, sessionRow:16384, wrapper:16384, assertions:1024, reasons:1024 });
export type HookEvent = typeof CLAUDE_HOOK_EVENTS[number];
export type SelectorV2 = {kind:"main"} | {kind:"agent";agentId:string};
export interface AdmissionRequestV2 {version:2;sourceSessionIdentity:string;claims:HookSourceClaims;event:HookEvent;selector:SelectorV2;}
export interface DescriptorStateV2 {contextKey:string;incarnationKey:string|null;transcriptCursor:number;prefixBytes:number;prefixSha256:string|null;observedFileBytes:number;revision:number;}
export type AgentContextV2 = [string,string|null,number,number,string|null,number,number];
export interface RetainedSessionV2 {version:2;coverage:"partial";runtimeVerified:false;producerVerified:false;revision:number;mainRevision:number;reasons:string[];agents:AgentContextV2[];unlinkedAssertions:NormalizedClaudeBatch["unlinkedAssertions"];}
export interface DescriptorReceiptV2 {contextKey:string;incarnationKey:string;sourceOffset:number;contextRevision:number;}
export interface RetainedEntityV2 {version:2;entity:NormalizedClaudeEntity;origin:DescriptorReceiptV2|null;observedSha256:string;}
export interface BatchV2 {event:HookEvent;sourceKey:string;sessionClosureClaim:boolean;runtimeVerified:false;producerVerified:false;coverage:"partial";coverageReasons:string[];entities:NormalizedClaudeEntity[];unlinkedAssertions:NormalizedClaudeBatch["unlinkedAssertions"];transcriptCursor:number;incarnationKey:string;prefixBytes:number;prefixSha256:string|null;observedFileBytes:number;}
export interface PublicationRequestV2 {version:2;dispatch:"context-v2";ownerGeneration:string;installationGeneration:string;sourceKey:string;event:HookEvent;selector:SelectorV2;contextKey:string;descriptorRevision:number;sessionRevision:number;retainedSessionSha256:string;batch:BatchV2;}
export interface TransitionRequestV2 {action:"activate-context-v2";installationIds:string[];expectedOwnerGeneration:string;expectedInstallations:{installationId:string;generation:string;configSha256:string;catalogSha256:string}[];}
const object = (value:HookJson):value is {[key:string]:HookJson} => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function closedContextObject(value:HookJson, keys:string[]):{[key:string]:HookJson} {if(!object(value)||Object.keys(value).join(",")!==keys.join(","))refuse("malformed",400);return value;}
function scalar(value:HookJson):boolean {
 if(typeof value === "string"){for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
 if(Array.isArray(value))return value.every(scalar);if(object(value))return Object.keys(value).every(key=>scalar(key))&&Object.values(value).every(scalar);return true;
}
export function parseContextJson(raw:unknown, bytes=16384):HookJson {const parsed=parseBoundedHookJson(raw,bytes);if(parsed.status!=="accepted"||!scalar(parsed.value)||JSON.stringify(parsed.value)!==raw)refuse("malformed",400);return parsed.value;}
const event = (value:HookJson):HookEvent => {for(const event of CLAUDE_HOOK_EVENTS)if(event===value)return event;return refuse("malformed",400);};
export function selectorV2(value:HookJson, hookEvent:HookEvent):SelectorV2 {
 if(!object(value))refuse("malformed",400);
 if(value.kind==="main"){closedContextObject(value,["kind"]);return {kind:"main"};}
 closedContextObject(value,["kind","agentId"]);if(value.kind!=="agent"||hookEvent!=="SubagentStop"||typeof value.agentId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value.agentId))refuse("malformed",400);return {kind:"agent",agentId:value.agentId};
}
export const agentIdentityV2 = (id:string):string => hookDigest(id);
export const contextKeyV2 = (sourceKey:string,selector:SelectorV2):string => hookDigest(JSON.stringify(selector.kind==="main"?[sourceKey,"main"]:[sourceKey,"agent",agentIdentityV2(selector.agentId)]));
export function parseAdmissionV2(raw:unknown):AdmissionRequestV2 {
 const v=closedContextObject(parseContextJson(raw),["version","sourceSessionIdentity","claims","event","selector"]),c=closedContextObject(v.claims,["workspaceClaim","projectClaim"]),e=event(v.event);
 if(v.version!==2||!isHex(v.sourceSessionIdentity,64)||!isHex(c.workspaceClaim,64)||!isHex(c.projectClaim,64))refuse("malformed",400);
 return {version:2,sourceSessionIdentity:v.sourceSessionIdentity,claims:{workspaceClaim:c.workspaceClaim,projectClaim:c.projectClaim},event:e,selector:selectorV2(v.selector,e)};
}
export function descriptorV2(value:HookJson):DescriptorStateV2 {
 const v=closedContextObject(value,["contextKey","incarnationKey","transcriptCursor","prefixBytes","prefixSha256","observedFileBytes","revision"]);
 if(v.incarnationKey!==null&&!isHex(v.incarnationKey,64)||v.prefixSha256!==null&&!isHex(v.prefixSha256,64))refuse("malformed",400);
 if(!isHex(v.contextKey,64)||!boundedInteger(v.transcriptCursor,8388608)||!boundedInteger(v.prefixBytes,65536)||!boundedInteger(v.observedFileBytes,8388608)||!boundedInteger(v.revision,999999)
  ||v.transcriptCursor>v.observedFileBytes||v.prefixBytes>v.observedFileBytes
  ||(v.prefixBytes===0?v.prefixSha256!==null:!isHex(v.prefixSha256,64))
  ||(v.incarnationKey===null?v.transcriptCursor!==0||v.prefixBytes!==0||v.observedFileBytes!==0||v.revision!==0:!isHex(v.incarnationKey,64)||v.revision<1)
  ||v.transcriptCursor>0&&v.prefixBytes===0)refuse("malformed",400);
 return {contextKey:v.contextKey,incarnationKey:v.incarnationKey,transcriptCursor:v.transcriptCursor,prefixBytes:v.prefixBytes,prefixSha256:v.prefixSha256,observedFileBytes:v.observedFileBytes,revision:v.revision};
}
function reasons(value:HookJson,max=32):string[] {if(!validCoverageReasons(value)||value.length>max||new Set(value).size!==value.length||Buffer.byteLength(JSON.stringify(value))>1024)refuse("malformed",400);return [...value];}
export function assertionsV2(value:HookJson):NormalizedClaudeBatch["unlinkedAssertions"] {
 if(value===null)return null;const a=closedContextObject(value,["prompt","assistant","error"]);
 if(!(a.prompt===null||typeof a.prompt==="string"&&a.prompt.length<=4096)||!(a.assistant===null||typeof a.assistant==="string"&&a.assistant.length<=4096)||!(a.error===null||typeof a.error==="string"&&a.error.length<=4096))refuse("malformed",400);
 const result={prompt:a.prompt,assistant:a.assistant,error:a.error};if(JSON.stringify(sanitizeClaudeRetention({bodies:[],assertions:result}).value)!==JSON.stringify({bodies:[],assertions:result}))refuse("malformed",400);return result;
}
export function retainedSessionV2(raw:unknown):RetainedSessionV2 {
 const v=closedContextObject(parseContextJson(raw,12288),["version","coverage","runtimeVerified","producerVerified","revision","mainRevision","reasons","agents","unlinkedAssertions"]);
 if(v.version!==2||v.coverage!=="partial"||v.runtimeVerified!==false||v.producerVerified!==false||!boundedInteger(v.revision,999999)||v.revision<1||!boundedInteger(v.mainRevision,999999)||!Array.isArray(v.agents)||v.agents.length>32||Buffer.byteLength(JSON.stringify(v.agents))>8192)refuse("malformed",400);
 const agents:AgentContextV2[]=[];let previous="";
 for(const t of v.agents){if(!Array.isArray(t)||t.length!==7||!isHex(t[0],64)||t[0]<=previous||Buffer.byteLength(JSON.stringify(t))>256)refuse("malformed",400);
  const d=descriptorV2({contextKey:t[0],incarnationKey:t[1],transcriptCursor:t[2],prefixBytes:t[3],prefixSha256:t[4],observedFileBytes:t[5],revision:t[6]});agents.push([t[0],d.incarnationKey,d.transcriptCursor,d.prefixBytes,d.prefixSha256,d.observedFileBytes,d.revision]);previous=t[0];}
 const assertions=assertionsV2(v.unlinkedAssertions);if(Buffer.byteLength(JSON.stringify(assertions))>1024)refuse("malformed",400);
 return {version:2,coverage:"partial",runtimeVerified:false,producerVerified:false,revision:v.revision,mainRevision:v.mainRevision,reasons:reasons(v.reasons),agents,unlinkedAssertions:assertions};
}
export function sessionDigestV2(row:CompleteSessionRow):string {if(Buffer.byteLength(JSON.stringify(row))>16384)refuse("quota",507);retainedSessionV2(row.data);return hookDigest(JSON.stringify(row));}
function validateEntityLayoutV2(entity:NormalizedClaudeEntity):void {
 if ((entity.kind === "prompt" || entity.kind === "assistant") && entity.sourceKind !== "transcript"
  || (entity.kind === "session" || entity.kind === "subagent") && entity.sourceKind !== "hook"
  || entity.kind !== "assistant" && entity.model !== null) refuse("malformed",400);
 const body=entity.body;if(body===null)return;
 if(entity.kind==="session"||entity.kind==="subagent")refuse("malformed",400);
 const blocks=(value:HookJson,toolUse:boolean):boolean => Array.isArray(value)&&value.every(part=>{
  if(!object(part))return false;
  if(part.type==="text")return Object.keys(part).sort().join(",")==="text,type"&&typeof part.text==="string";
  return toolUse&&part.type==="tool_use"&&Object.keys(part).sort().join(",")==="input,name,toolIdentity,type"&&isHex(part.toolIdentity,64)&&typeof part.name==="string"&&part.name.length<=256;
 });
 if(entity.kind==="assistant"&&(body.input!==null||body.error!==null||body.output!==null&&!blocks(body.output,true))
  ||entity.kind==="prompt"&&(body.output!==null||body.error!==null||body.input!==null&&typeof body.input!=="string"&&!blocks(body.input,false)))refuse("malformed",400);
}
export function retainedEntityV2(raw:unknown,sourceKey:string,contexts:ReadonlyMap<string,DescriptorStateV2>):RetainedEntityV2 {
 const v=closedContextObject(parseContextJson(raw),["version","entity","origin","observedSha256"]);if(v.version!==2||!isHex(v.observedSha256,64)||!object(v.entity))refuse("malformed",400);
 let origin:DescriptorReceiptV2|null=null;
 if(v.origin!==null){const o=closedContextObject(v.origin,["contextKey","incarnationKey","sourceOffset","contextRevision"]);
  if(!isHex(o.contextKey,64)||!isHex(o.incarnationKey,64)||!boundedInteger(o.sourceOffset,8388608)||!boundedInteger(o.contextRevision,999999)||o.contextRevision<1)refuse("malformed",400);
  const d=contexts.get(o.contextKey);if(!d||d.incarnationKey!==o.incarnationKey||o.sourceOffset>d.transcriptCursor||o.contextRevision>d.revision)refuse("corrupt",503);
  origin={contextKey:o.contextKey,incarnationKey:o.incarnationKey,sourceOffset:o.sourceOffset,contextRevision:o.contextRevision};}
 const entity=validateClaudeRetainedEntity(JSON.stringify(v.entity),sourceKey,origin?.incarnationKey??null,origin?contexts.get(origin.contextKey)!.transcriptCursor:0);
 validateEntityLayoutV2(entity);
 if(entity.sourceKind==="hook"?origin!==null:!origin||entity.incarnationKey!==origin.incarnationKey||entity.sourceOffset!==origin.sourceOffset)refuse("corrupt",503);
 return {version:2,entity,origin,observedSha256:v.observedSha256};
}
export function batchV2(value:HookJson,sourceKey:string,hookEvent:HookEvent,selector:SelectorV2,mode:"metadata"|"full"):BatchV2 {
 const v=closedContextObject(value,["event","sourceKey","sessionClosureClaim","runtimeVerified","producerVerified","coverage","coverageReasons","entities","unlinkedAssertions","transcriptCursor","incarnationKey","prefixBytes","prefixSha256","observedFileBytes"]);
 if(v.event!==hookEvent||v.sourceKey!==sourceKey||v.sessionClosureClaim!==(selector.kind==="main"&&hookEvent==="SessionEnd")||v.runtimeVerified!==false||v.producerVerified!==false||v.coverage!=="partial"||!isHex(v.incarnationKey,64)||!Array.isArray(v.entities)||!v.entities.length||v.entities.length>(selector.kind==="main"?128:127))refuse("malformed",400);
 const d=descriptorV2({contextKey:contextKeyV2(sourceKey,selector),incarnationKey:v.incarnationKey,transcriptCursor:v.transcriptCursor,prefixBytes:v.prefixBytes,prefixSha256:v.prefixSha256,observedFileBytes:v.observedFileBytes,revision:1});
 const entities:NormalizedClaudeEntity[]=[],ids=new Set<string>();let roots=0,agents=0;
 for(const candidate of v.entities){const entity=validateClaudeRetainedEntity(JSON.stringify(candidate),sourceKey,d.incarnationKey,d.transcriptCursor);if(ids.has(entity.entityKey))refuse("malformed",400);ids.add(entity.entityKey);
  validateEntityLayoutV2(entity);
  if(entity.kind==="session"){roots++;if(selector.kind!=="main"||entity.sourceKind!=="hook"||entity.model!==null||entity.phase!==(hookEvent==="SessionEnd"?"complete":"pending"))refuse("malformed",400);}
  if(selector.kind==="agent"&&entity.sourceKind==="hook"){if(entity.kind!=="subagent"||entity.phase!=="complete"||entity.entityKey!==hookDigest(JSON.stringify(["runphantom.claude.entity/v1",sourceKey,"subagent",selector.agentId])))refuse("malformed",400);agents++;}
  entities.push(mode==="metadata"?{...entity,body:null}:entity);
 }
 if(selector.kind==="main"?roots!==1:roots!==0||agents!==1||v.unlinkedAssertions!==null)refuse("malformed",400);
 const validatedAssertions=assertionsV2(v.unlinkedAssertions);
 let assertions=mode==="metadata"?null:validatedAssertions;const coverageReasons=reasons(v.coverageReasons);
 if(Buffer.byteLength(JSON.stringify(assertions))>1024){assertions=null;if(!coverageReasons.includes("body_partial"))coverageReasons.push("body_partial");}
 return {event:hookEvent,sourceKey,sessionClosureClaim:v.sessionClosureClaim,runtimeVerified:false,producerVerified:false,coverage:"partial",coverageReasons:reasons(coverageReasons),entities,unlinkedAssertions:assertions,transcriptCursor:d.transcriptCursor,incarnationKey:v.incarnationKey,prefixBytes:d.prefixBytes,prefixSha256:d.prefixSha256,observedFileBytes:d.observedFileBytes};
}
export function parsePublicationV2(raw:unknown,mode:"metadata"|"full"):PublicationRequestV2 {
 const v=closedContextObject(parseContextJson(raw,262144),["version","dispatch","ownerGeneration","installationGeneration","sourceKey","event","selector","contextKey","descriptorRevision","sessionRevision","retainedSessionSha256","batch"]),e=event(v.event),s=selectorV2(v.selector,e);
 if(v.version!==2||v.dispatch!=="context-v2"||!isHex(v.ownerGeneration,32)||!isHex(v.installationGeneration,32)||!isHex(v.sourceKey,64)||!isHex(v.contextKey,64)||v.contextKey!==contextKeyV2(v.sourceKey,s)||!boundedInteger(v.descriptorRevision,999999)||!boundedInteger(v.sessionRevision,999999)||v.sessionRevision<1||!isHex(v.retainedSessionSha256,64))refuse("malformed",400);
 return {version:2,dispatch:"context-v2",ownerGeneration:v.ownerGeneration,installationGeneration:v.installationGeneration,sourceKey:v.sourceKey,event:e,selector:s,contextKey:v.contextKey,descriptorRevision:v.descriptorRevision,sessionRevision:v.sessionRevision,retainedSessionSha256:v.retainedSessionSha256,batch:batchV2(v.batch,v.sourceKey,e,s,mode)};
}
export function parseTransitionV2(raw:unknown):TransitionRequestV2 {
 const v=closedContextObject(parseContextJson(raw),["action","installationIds","expectedOwnerGeneration","expectedInstallations"]);
 if(v.action!=="activate-context-v2"||!isHex(v.expectedOwnerGeneration,32)||!Array.isArray(v.installationIds)||!v.installationIds.length||v.installationIds.length>64||!Array.isArray(v.expectedInstallations)||v.expectedInstallations.length!==v.installationIds.length)refuse("malformed",400);
 const ids:string[]=[],expected:TransitionRequestV2["expectedInstallations"]=[];let previous="";
 for(let i=0;i<v.installationIds.length;i++){const id=v.installationIds[i],r=closedContextObject(v.expectedInstallations[i],["installationId","generation","configSha256","catalogSha256"]);if(!isHex(id,32)||id<=previous||r.installationId!==id||!isHex(r.generation,32)||!isHex(r.configSha256,64)||!isHex(r.catalogSha256,64))refuse("malformed",400);ids.push(id);expected.push({installationId:id,generation:r.generation,configSha256:r.configSha256,catalogSha256:r.catalogSha256});previous=id;}
 return {action:"activate-context-v2",installationIds:ids,expectedOwnerGeneration:v.expectedOwnerGeneration,expectedInstallations:expected};
}
