import { CONTEXT_CAPTURE_CONTRACT, retainedEntityV2, type DescriptorStateV2 } from "./context-v2";
import { claudeEntityProjection } from "./projection";
import { hookDigest, isHex, refuse } from "./protocol";

/** Closed NEXT wrapper validation precedes projection. Session witness remains separate to avoid recursion. */
export function contextEntityProjection(retained:string,sourceKey:string,session:{runId:string;rootSpanId:string},mode:"metadata"|"full",contexts:ReadonlyMap<string,DescriptorStateV2>,sessionDigest:string|null) {
 const wrapper=retainedEntityV2(retained,sourceKey,contexts),entity=wrapper.entity;
 if(entity.kind==="session"?!isHex(sessionDigest,64):sessionDigest!==null)refuse("corrupt",503);
 return {...claudeEntityProjection(entity,session,mode,retained),attributes:JSON.stringify({source:"claude_hook",producerVerified:false,runtimeVerified:false,coverage:"partial",coverageReasons:entity.coverageReasons,reportedPhase:entity.phase,reportedDurationMs:entity.reportedDurationMs,usage:entity.usage,currentCapturePolicy:mode,retainedBody:entity.body!==null,retainedEntitySha256:hookDigest(retained),captureContract:CONTEXT_CAPTURE_CONTRACT,entityKind:entity.kind,sourceKind:entity.sourceKind,captureModel:entity.model,contextKey:wrapper.origin?.contextKey??null,contextRevision:wrapper.origin?.contextRevision??null,sessionContextVersion:entity.kind==="session"?2:null,retainedSessionSha256:sessionDigest})};
}
