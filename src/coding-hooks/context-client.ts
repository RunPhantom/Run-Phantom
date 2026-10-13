import path from "node:path";
import { readClaudeCapabilityDescriptor, type ClaudeCapabilityDescriptor } from "./capability";
import { postClaudeHook, validateMainAdmission } from "./client";
import { acquireRegisteredClaudeTranscript, acquireRegisteredContextTranscript } from "./acquisition";
import { normalizeClaudeHook } from "./claude";
import { hookDigest, HOOK_PROTOCOL, isHex, refuse } from "./protocol";
import { closedContextObject, parseContextJson, selectorV2, descriptorV2, contextKeyV2, parsePublicationV2 } from "./context-v2";
import type { ContextAdmissionV2 } from "./context-store";
import type { InstallationBinding } from "./store";
import type { ClaudeHookInput } from "./shared";

function bindingV2(value:ReturnType<typeof parseContextJson>,cap:ClaudeCapabilityDescriptor,hook:ClaudeHookInput,project:string):InstallationBinding {
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="captureMode,executable,homeDirectory,installationId,projectDirectory,registeredWorkspace,scope,settingsPath,transcriptRoot,workspace")refuse("malformed",400);
 const b=value;
 if(b.installationId!==cap.installationId||!isHex(b.installationId,32)||(b.scope!=="local"&&b.scope!=="global")||(b.captureMode!=="metadata"&&b.captureMode!=="full")||b.registeredWorkspace!==hook.cwd||b.projectDirectory!==project||(b.workspace!==null&&typeof b.workspace!=="string")||b.scope==="global"&&(b.workspace!==null||b.captureMode!=="metadata")||b.scope==="local"&&b.workspace!==b.registeredWorkspace)refuse("malformed",400);
 if(typeof b.registeredWorkspace!=="string"||typeof b.transcriptRoot!=="string"||typeof b.projectDirectory!=="string"||typeof b.homeDirectory!=="string"||typeof b.settingsPath!=="string"||typeof b.executable!=="string")refuse("malformed",400);
 for(const p of [b.registeredWorkspace,b.transcriptRoot,b.projectDirectory,b.homeDirectory,b.settingsPath,b.executable])if(!path.isAbsolute(p)||path.normalize(p)!==p||p.includes("\0")||Buffer.byteLength(p)>4096)refuse("malformed",400);
 const relative=path.relative(b.transcriptRoot,project);if(!relative||relative.includes(path.sep)||relative===".."||path.isAbsolute(relative))refuse("malformed",400);
 return {installationId:b.installationId,scope:b.scope,captureMode:b.captureMode,workspace:b.workspace,registeredWorkspace:b.registeredWorkspace,transcriptRoot:b.transcriptRoot,projectDirectory:b.projectDirectory,homeDirectory:b.homeDirectory,settingsPath:b.settingsPath,executable:b.executable};
}
/** Explicit internal fixture entry only. Normal installed callback never imports/selects this protocol. */
export async function captureClaudeContextHook(raw:string,hook:ClaudeHookInput,file:string,id:string,signal:AbortSignal,internalContextTransport=false):Promise<void> {
 if(!internalContextTransport)return;const cap=await readClaudeCapabilityDescriptor(file,id,undefined,signal);if(cap.state!=="active"||!hook.cwd||!hook.transcriptPath||hook.transcriptPath!==path.join(path.dirname(hook.transcriptPath),hook.sessionId+".jsonl"))return;
 const project=path.dirname(hook.transcriptPath),selector=hook.event==="SubagentStop"?selectorV2({kind:"agent",agentId:hook.agentId},hook.event):selectorV2({kind:"main"},hook.event);
 // Sensitive path claims are checked before admission; they register no authority.
 if(selector.kind==="agent"&&hook.agentTranscriptPath!==path.join(project,hook.sessionId,"subagents","agent-"+selector.agentId+".jsonl"))return;
 const reply=await postClaudeHook(cap,"admission",{version:2,sourceSessionIdentity:hookDigest(JSON.stringify(["runphantom.claude.session-identity/v1",hook.sessionId])),claims:{workspaceClaim:hookDigest(JSON.stringify(["runphantom.claude.workspace-claim/v1",hook.cwd])),projectClaim:hookDigest(JSON.stringify(["runphantom.claude.project-claim/v1",project]))},event:hook.event,selector},signal),value=parseContextJson(JSON.stringify(reply));
 if(!value||typeof value!=="object"||Array.isArray(value))return;
 if(value.dispatch==="legacy-main-v1"){
  const v=closedContextObject(value,["version","status","dispatch","event","selector","admission"]);if(v.version!==2||v.status!=="accepted"||v.event!==hook.event||selector.kind!=="main"||JSON.stringify(v.selector)!=='{"kind":"main"}'||!v.admission||typeof v.admission!=="object"||Array.isArray(v.admission))return;
  const a=validateMainAdmission(v.admission,cap,hook,project),fd=await acquireRegisteredClaudeTranscript(hook,a,signal);if(fd.status!=="accepted"||signal.aborted)return;const normalized=normalizeClaudeHook(raw,{sourceKey:a.sourceKey,captureMode:a.captureMode},fd.value);if(normalized.status!=="accepted"||signal.aborted)return;await postClaudeHook(cap,"publication",{version:HOOK_PROTOCOL,ownerGeneration:a.ownerGeneration,installationGeneration:a.installationGeneration,sourceKey:a.sourceKey,batch:normalized.value},signal);return;
 }
 const v=closedContextObject(value,["version","status","dispatch","ownerGeneration","installationGeneration","sourceKey","runId","rootSpanId","captureMode","runtimeVerified","producerVerified","coverage","binding","event","selector","descriptor","sessionRevision","retainedSessionSha256"]);
 if(v.version!==2||v.status!=="accepted"||v.dispatch!=="context-v2"||!isHex(v.ownerGeneration,32)||v.ownerGeneration!==cap.ownerGeneration||!isHex(v.installationGeneration,32)||v.installationGeneration!==cap.installationGeneration||!isHex(v.sourceKey,64)||v.runId!==v.sourceKey.slice(0,32)||!isHex(v.runId,32)||v.rootSpanId!==hookDigest(v.sourceKey+"root").slice(0,16)||!isHex(v.rootSpanId,16)||(v.captureMode!=="metadata"&&v.captureMode!=="full")||v.runtimeVerified!==false||v.producerVerified!==false||v.coverage!=="partial"||v.event!==hook.event||JSON.stringify(v.selector)!==JSON.stringify(selector)||typeof v.sessionRevision!=="number"||!Number.isSafeInteger(v.sessionRevision)||v.sessionRevision<1||v.sessionRevision>999999||!isHex(v.retainedSessionSha256,64))return;
 const binding=bindingV2(v.binding,cap,hook,project),descriptor=descriptorV2(v.descriptor);if(binding.captureMode!==v.captureMode||descriptor.contextKey!==contextKeyV2(v.sourceKey,selector))return;
 const a:ContextAdmissionV2={version:2,status:"accepted",dispatch:"context-v2",ownerGeneration:v.ownerGeneration,installationGeneration:v.installationGeneration,sourceKey:v.sourceKey,runId:v.runId,rootSpanId:v.rootSpanId,captureMode:v.captureMode,runtimeVerified:false,producerVerified:false,coverage:"partial",binding,event:hook.event,selector,descriptor,sessionRevision:v.sessionRevision,retainedSessionSha256:v.retainedSessionSha256};
 const fd=await acquireRegisteredContextTranscript(hook,a,signal);if(fd.status!=="accepted"||signal.aborted)return;const normalized=normalizeClaudeHook(raw,{sourceKey:a.sourceKey,captureMode:a.captureMode},fd.value);if(normalized.status!=="accepted"||signal.aborted)return;
 const batch=selector.kind==="agent"?{...normalized.value,entities:normalized.value.entities.filter(entity=>entity.kind!=="session"),sessionClosureClaim:false,unlinkedAssertions:null}:normalized.value;
 const publication={version:2,dispatch:"context-v2",ownerGeneration:a.ownerGeneration,installationGeneration:a.installationGeneration,sourceKey:a.sourceKey,event:a.event,selector,contextKey:descriptor.contextKey,descriptorRevision:descriptor.revision,sessionRevision:a.sessionRevision,retainedSessionSha256:a.retainedSessionSha256,batch};parsePublicationV2(JSON.stringify(publication),a.captureMode);await postClaudeHook(cap,"publication",publication,signal);
}
