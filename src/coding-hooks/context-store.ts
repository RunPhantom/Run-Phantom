import { CodingHookStore, type InstallationBinding, type HookAdmission } from "./store";
import { CATALOG_CONTEXT_VERSION, selectRegistration } from "./catalog";
import { hookDigest, isHex, refuse, HOOK_PROTOCOL } from "./protocol";
import { parseBoundedHookJson } from "./shared";
import type { NormalizedClaudeEntity } from "./claude";
import { contextEntityProjection } from "./context-projection";
import { readCompleteSession, validateSessionColumns, validateLegacySource, readCanonical, CANONICAL_COLUMNS, type CompleteSessionRow } from "./retained-version";
import { agentIdentityV2, contextKeyV2, descriptorV2, retainedSessionV2, retainedEntityV2, sessionDigestV2, parsePublicationV2, type AdmissionRequestV2, type DescriptorStateV2, type SelectorV2, type RetainedSessionV2, type RetainedEntityV2, type PublicationRequestV2 } from "./context-v2";

export interface ContextAdmissionV2 {
 version:2;status:"accepted";dispatch:"context-v2";ownerGeneration:string;installationGeneration:string;sourceKey:string;runId:string;rootSpanId:string;captureMode:"metadata"|"full";runtimeVerified:false;producerVerified:false;coverage:"partial";binding:InstallationBinding;event:AdmissionRequestV2["event"];selector:SelectorV2;descriptor:DescriptorStateV2;sessionRevision:number;retainedSessionSha256:string;
}
export interface LegacyMainAdmissionV2 {version:2;status:"accepted";dispatch:"legacy-main-v1";event:AdmissionRequestV2["event"];selector:{kind:"main"};admission:HookAdmission&{version:typeof HOOK_PROTOCOL;coverage:"partial";producerVerified:false;runtimeVerified:false};}
interface CacheRow {entity_key:string;span_id:string;kind:string;phase:string;incarnation_key:string|null;source_offset:number|null;observation_sha256:string;projection_sha256:string;data:string;updated_at:number;}
interface Verified {row:CompleteSessionRow;data:RetainedSessionV2;contexts:Map<string,DescriptorStateV2>;entities:Map<string,{row:CacheRow;wrapper:RetainedEntityV2;mode:"metadata"|"full"}>;digest:string;}
const terminal=(phase:NormalizedClaudeEntity["phase"])=>["success","failure","interrupted","complete","conflict"].includes(phase);
const rootEntity=(key:string):NormalizedClaudeEntity=>({entityKey:hookDigest(JSON.stringify(["runphantom.claude.entity/v1",key,"session","root"])),kind:"session",phase:"pending",name:"Claude session",model:null,sourceKind:"hook",incarnationKey:null,sourceOffset:null,reportedAt:null,reportedDurationMs:null,runtimeDurationMs:null,runtimeVerified:false,producerVerified:false,usage:null,body:null,coverageReasons:["producer_unverified"]});
export function contextMapV2(row:CompleteSessionRow,data:RetainedSessionV2):Map<string,DescriptorStateV2> {
 const map=new Map<string,DescriptorStateV2>(),main=descriptorV2({contextKey:contextKeyV2(row.source_key,{kind:"main"}),incarnationKey:row.incarnation_key,transcriptCursor:row.source_cursor,prefixBytes:row.prefix_bytes,prefixSha256:row.prefix_sha256,observedFileBytes:row.observed_file_bytes,revision:data.mainRevision});map.set(main.contextKey,main);
 for(const t of data.agents){const key=hookDigest(JSON.stringify([row.source_key,"agent",t[0]]));map.set(key,descriptorV2({contextKey:key,incarnationKey:t[1],transcriptCursor:t[2],prefixBytes:t[3],prefixSha256:t[4],observedFileBytes:t[5],revision:t[6]}));}return map;
}
/** Inactive by default: the existing owned connection and explicit test/management gate are required. */
export class ContextHookStore {
 constructor(readonly store:CodingHookStore){}
 assertCurrentQuota():void { this.atomic(deadline=>this.quota(deadline)); }
 private atomic<T>(work:(deadline:()=>void)=>T):T {const start=performance.now(),deadline=()=>{if(performance.now()-start>250)refuse("deadline",503);};return this.store.contextTransaction(()=>{deadline();const result=work(deadline);deadline();return result;});}
 private verify(key:string,registration:string,deadline:()=>void):Verified {
  const row=readCompleteSession(this.store.db,key);if(!row)refuse("corrupt",503);if(row.state==="suppressed")refuse("suppressed");validateSessionColumns(row,key,registration);
  const data=retainedSessionV2(row.data),contexts=contextMapV2(row,data),digest=sessionDigestV2(row);
  if(!this.store.db.query("SELECT 1 FROM runs WHERE id=?").get(row.run_id))refuse("corrupt",503);
  const rows=this.store.db.query("SELECT entity_key,span_id,kind,phase,incarnation_key,source_offset,observation_sha256,projection_sha256,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data,updated_at FROM coding_hook_entities WHERE source_key=? ORDER BY entity_key LIMIT 1001").all(key) as CacheRow[];
  if(rows.length>1000)refuse("quota",507);const entities:Verified["entities"]=new Map();let roots=0;const spanIds=new Set<string>();
  for(const cached of rows){deadline();const wrapper=retainedEntityV2(cached.data,key,contexts),e=wrapper.entity,span=e.kind==="session"?row.root_span_id:e.entityKey.slice(0,16);
   if(cached.entity_key!==e.entityKey||cached.span_id!==span||cached.kind!==e.kind||cached.phase!==e.phase||cached.incarnation_key!==e.incarnationKey||cached.source_offset!==e.sourceOffset||cached.observation_sha256!==wrapper.observedSha256||!isHex(cached.projection_sha256,64))refuse("corrupt",503);
   const canonical=readCanonical(this.store.db,row.run_id,span);if(!canonical||hookDigest(JSON.stringify(canonical))!==cached.projection_sha256)refuse("corrupt",503);
   const a=parseBoundedHookJson(canonical.attributes,16384);if(a.status!=="accepted"||!a.value||typeof a.value!=="object"||Array.isArray(a.value)||(a.value.currentCapturePolicy!=="full"&&a.value.currentCapturePolicy!=="metadata"))refuse("corrupt",503);
   const mode=a.value.currentCapturePolicy;if(JSON.stringify(contextEntityProjection(cached.data,key,{runId:row.run_id,rootSpanId:row.root_span_id},mode,contexts,e.kind==="session"?digest:null))!==JSON.stringify(canonical))refuse("corrupt",503);
   if(e.kind==="session"){roots++;if(e.sourceKind!=="hook"||e.model!==null||e.body!==null||e.usage!==null||e.phase!==(row.state==="closed"?"complete":"pending"))refuse("corrupt",503);}
   entities.set(e.entityKey,{row:cached,wrapper,mode});spanIds.add(span);
  }
  if(roots!==1)refuse("corrupt",503);
  const spans=this.store.db.query("SELECT id,CASE WHEN length(CAST(attributes AS BLOB))<=16384 THEN attributes END attributes FROM spans WHERE run_id=? AND CASE WHEN json_valid(attributes) THEN json_extract(attributes,'$.source')='claude_hook' OR json_extract(attributes,'$.captureContract') LIKE 'runphantom.claude-hook.observation/%' ELSE attributes LIKE '%runphantom.claude-hook.observation/%' END LIMIT 1001").all(row.run_id) as {id:string;attributes:string|null}[];
  if(spans.length>1000)refuse("quota",507);for(const span of spans){deadline();if(spanIds.has(span.id))continue;const a=parseBoundedHookJson(span.attributes,16384);if(a.status==="accepted"&&a.value&&typeof a.value==="object"&&!Array.isArray(a.value)&&(a.value.source==="claude_hook"||typeof a.value.captureContract==="string"&&a.value.captureContract.startsWith("runphantom.claude-hook.observation/")))refuse("corrupt",503);}
  return {row,data,contexts,entities,digest};
 }
 private quota(deadline:()=>void):void {
  const sources=this.store.db.query("SELECT DISTINCT source_key FROM coding_hook_entities LIMIT 100001").all() as {source_key:string}[];if(sources.length>100000)refuse("quota",507);let bytes=0;
  for(const source of sources){deadline();const session=readCompleteSession(this.store.db,source.source_key);if(!session)refuse("corrupt",503);const version=validateLegacySource(this.store.db,source.source_key,session.source_root_key);if(version==="context-v2")this.verify(source.source_key,session.source_root_key,deadline);
   const spans=this.store.db.query(`SELECT DISTINCT ${CANONICAL_COLUMNS.map(c=>`s.${c}`).join(",")} FROM spans s JOIN coding_hook_entities e ON s.run_id=? AND e.source_key=? AND s.id=e.span_id`).all(session.run_id,source.source_key) as Record<string,unknown>[];for(const span of spans){deadline();bytes+=Buffer.byteLength(JSON.stringify(span));}}
  this.store.assertContextQuota(bytes);
 }
 private writeProjection(row:CompleteSessionRow,wrapper:RetainedEntityV2,mode:"metadata"|"full",contexts:ReadonlyMap<string,DescriptorStateV2>,digest:string,now:number):void {
  const retained=JSON.stringify(wrapper);if(Buffer.byteLength(retained)>16384)refuse("quota",507);const e=wrapper.entity,projection=contextEntityProjection(retained,row.source_key,{runId:row.run_id,rootSpanId:row.root_span_id},mode,contexts,e.kind==="session"?digest:null),columns=Object.keys(projection);
  this.store.db.query(`INSERT INTO spans(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")}) ON CONFLICT(run_id,id) DO UPDATE SET ${columns.filter(c=>c!=="id"&&c!=="run_id").map(c=>`${c}=excluded.${c}`).join(",")}`).run(...Object.values(projection));
  this.store.db.query("INSERT INTO coding_hook_entities VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key,entity_key) DO UPDATE SET phase=excluded.phase,incarnation_key=excluded.incarnation_key,source_offset=excluded.source_offset,observation_sha256=excluded.observation_sha256,projection_sha256=excluded.projection_sha256,data=excluded.data,updated_at=excluded.updated_at").run(row.source_key,e.entityKey,projection.id,e.kind,e.phase,e.incarnationKey,e.sourceOffset,wrapper.observedSha256,hookDigest(JSON.stringify(projection)),retained,now);
 }
 private writeSession(row:CompleteSessionRow):void {this.store.db.query("UPDATE coding_hook_sessions SET state=?,incarnation_key=?,prefix_sha256=?,prefix_bytes=?,source_cursor=?,observed_file_bytes=?,data=?,updated_at=? WHERE source_key=?").run(row.state,row.incarnation_key,row.prefix_sha256,row.prefix_bytes,row.source_cursor,row.observed_file_bytes,row.data,row.updated_at,row.source_key);}
 admit(token:string,request:AdmissionRequestV2):ContextAdmissionV2|LegacyMainAdmissionV2 {
  return this.atomic(deadline=>{
   const a=this.store.authenticate(token),registration=selectRegistration(a.registrations,request.claims),key=hookDigest(JSON.stringify(["runphantom.claude.session/v1",a.sourceEpoch,registration.registrationId,request.sourceSessionIdentity]));
   const version=validateLegacySource(this.store.db,key,registration.registrationId);this.quota(deadline);
   if(version==="legacy-main-v1"||version==="absent"&&a.catalogVersion!==CATALOG_CONTEXT_VERSION){if(request.selector.kind!=="main")refuse("unavailable",409);const admission=this.store.admit(token,request.sourceSessionIdentity,request.claims);return {version:2,status:"accepted",dispatch:"legacy-main-v1",event:request.event,selector:{kind:"main"},admission:{version:HOOK_PROTOCOL,...admission,coverage:"partial",producerVerified:false,runtimeVerified:false}};}
   if(a.catalogVersion!==CATALOG_CONTEXT_VERSION)refuse("inactive",409);
   if(version==="absent"){
    const data:RetainedSessionV2={version:2,coverage:"partial",runtimeVerified:false,producerVerified:false,revision:1,mainRevision:0,reasons:["producer_unverified"],agents:request.selector.kind==="agent"?[[agentIdentityV2(request.selector.agentId),null,0,0,null,0,0]]:[],unlinkedAssertions:null},now=Date.now();
    const row:CompleteSessionRow={source_key:key,owner_id:1,source_root_key:registration.registrationId,run_id:key.slice(0,32),root_span_id:hookDigest(key+"root").slice(0,16),state:"open",incarnation_key:null,prefix_sha256:null,prefix_bytes:0,source_cursor:0,observed_file_bytes:0,data:JSON.stringify(data),created_at:now,updated_at:now};const digest=sessionDigestV2(row),entity=rootEntity(key);
    this.store.db.query("INSERT INTO coding_hook_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(row));this.store.db.query("INSERT INTO runs(id,name,started_at,last_updated_at,metadata) VALUES(?,'Claude session',?,?,?)").run(row.run_id,now,now,'{"source":"claude_hook","runtimeVerified":false,"coverage":"partial"}');
    this.writeProjection(row,{version:2,entity,origin:null,observedSha256:hookDigest(JSON.stringify(entity))},a.row.capture_mode,contextMapV2(row,data),digest,now);
   }
   let verified=this.verify(key,registration.registrationId,deadline);const context=contextKeyV2(key,request.selector);
   if(!verified.contexts.has(context)){
    if(request.selector.kind!=="agent"||verified.data.agents.length>=32||verified.data.revision>=999999)refuse("quota",507);
    verified.data.agents.push([agentIdentityV2(request.selector.agentId),null,0,0,null,0,0]);verified.data.agents.sort((x,y)=>x[0].localeCompare(y[0]));verified.data.revision++;
    verified.row.data=JSON.stringify(verified.data);verified.row.updated_at=Date.now();const digest=sessionDigestV2(verified.row),contexts=contextMapV2(verified.row,verified.data);this.writeSession(verified.row);
    const root=[...verified.entities.values()].find(item=>item.wrapper.entity.kind==="session");if(!root)refuse("corrupt",503);this.writeProjection(verified.row,root.wrapper,root.mode,contexts,digest,verified.row.updated_at);verified=this.verify(key,registration.registrationId,deadline);
   }
   this.quota(deadline);const descriptor=verified.contexts.get(context);if(!descriptor)refuse("corrupt",503);
   return {version:2,status:"accepted",dispatch:"context-v2",ownerGeneration:a.ownerGeneration,installationGeneration:a.row.generation,sourceKey:key,runId:verified.row.run_id,rootSpanId:verified.row.root_span_id,captureMode:a.row.capture_mode,runtimeVerified:false,producerVerified:false,coverage:"partial",binding:{...a.binding,registeredWorkspace:registration.registeredWorkspace,transcriptRoot:registration.transcriptRoot,projectDirectory:registration.projectDirectory,homeDirectory:registration.homeDirectory},event:request.event,selector:request.selector,descriptor,sessionRevision:verified.data.revision,retainedSessionSha256:verified.digest};
  });
 }
 publish(token:string,raw:string):{status:"accepted";runId:string;entities:number} {
  return this.atomic(deadline=>{
   const a=this.store.authenticate(token);if(a.catalogVersion!==CATALOG_CONTEXT_VERSION)refuse("inactive");const request=parsePublicationV2(raw,a.row.capture_mode);if(a.ownerGeneration!==request.ownerGeneration||a.row.generation!==request.installationGeneration)refuse("stale");
   const session=readCompleteSession(this.store.db,request.sourceKey);if(!session||!a.registrations.some(r=>r.registrationId===session.source_root_key))refuse("unauthorized",401);if(session.state==="suppressed")refuse("suppressed");
   const verified=this.verify(request.sourceKey,session.source_root_key,deadline);this.quota(deadline);return this.publishVerified(request,verified,a.row.capture_mode,deadline);
  });
 }
 private publishVerified(request:PublicationRequestV2,v:Verified,mode:"metadata"|"full",deadline:()=>void):{status:"accepted";runId:string;entities:number} {
  const old=v.contexts.get(request.contextKey);if(!old||old.revision!==request.descriptorRevision||v.data.revision!==request.sessionRevision||v.digest!==request.retainedSessionSha256)refuse("stale");const b=request.batch;
  if(old.incarnationKey!==null&&(old.incarnationKey!==b.incarnationKey||b.transcriptCursor<old.transcriptCursor||b.observedFileBytes<old.observedFileBytes||old.prefixBytes>0&&(b.prefixBytes!==old.prefixBytes||b.prefixSha256!==old.prefixSha256)))refuse("source_changed");
  const descriptorChanged=old.incarnationKey!==b.incarnationKey||old.transcriptCursor!==b.transcriptCursor||old.prefixBytes!==b.prefixBytes||old.prefixSha256!==b.prefixSha256||old.observedFileBytes!==b.observedFileBytes;
  const next:DescriptorStateV2={contextKey:request.contextKey,incarnationKey:b.incarnationKey,transcriptCursor:b.transcriptCursor,prefixBytes:b.prefixBytes,prefixSha256:b.prefixSha256,observedFileBytes:b.observedFileBytes,revision:old.revision+(descriptorChanged?1:0)};descriptorV2({...next});
  const updates:{wrapper:RetainedEntityV2;mode:"metadata"|"full"}[]=[],reasons=new Set([...v.data.reasons,...b.coverageReasons]);let changed=descriptorChanged;
  for(const observed of b.entities){deadline();const prior=v.entities.get(observed.entityKey);let entity=observed,origin=observed.sourceKind==="transcript"?{contextKey:next.contextKey,incarnationKey:b.incarnationKey,sourceOffset:observed.sourceOffset!,contextRevision:next.revision}:null;
   if(prior){const p=prior.wrapper.entity;if(p.kind!==observed.kind)refuse("source_changed");
    if(prior.wrapper.origin&&origin&&prior.wrapper.origin.contextKey!==origin.contextKey){const semantic=(e:NormalizedClaudeEntity)=>JSON.stringify({kind:e.kind,phase:e.phase,name:e.name,model:e.model,reportedAt:e.reportedAt,reportedDurationMs:e.reportedDurationMs,runtimeDurationMs:e.runtimeDurationMs,runtimeVerified:e.runtimeVerified,producerVerified:e.producerVerified,usage:e.usage});
     if(semantic(p)!==semantic(observed)||p.body!==null&&observed.body!==null&&JSON.stringify(p.body)!==JSON.stringify(observed.body))refuse("source_changed");if(p.body===null&&observed.body!==null)reasons.add("body_partial");continue;
    }
    if(p.sourceKind==="transcript"&&observed.sourceKind==="hook"||terminal(p.phase)&&observed.phase==="pending")continue;
    if(p.sourceOffset!==null&&observed.sourceOffset!==null){if(p.incarnationKey!==observed.incarnationKey)refuse("source_changed");if(observed.sourceOffset<p.sourceOffset)continue;if(observed.sourceOffset===p.sourceOffset&&mode==="metadata")continue;if(observed.sourceOffset===p.sourceOffset&&hookDigest(JSON.stringify(observed))!==prior.row.observation_sha256)refuse("source_changed");}
    if(terminal(p.phase)&&terminal(observed.phase)&&p.phase!==observed.phase)entity={...observed,phase:"conflict",coverageReasons:[...new Set([...p.coverageReasons,...observed.coverageReasons,"contradictory_terminal_claims"])]};
    if(mode==="metadata"&&p.body!==null)entity={...entity,body:p.body};
    if(observed.sourceKind==="hook"&&p.sourceKind==="hook"&&terminal(p.phase)&&entity.phase!=="conflict"&&prior.row.observation_sha256!==hookDigest(JSON.stringify(observed)))continue;
    if(JSON.stringify(entity)===JSON.stringify(p))continue;
    if(entity.sourceKind==="hook")origin=null;
   }
   const wrapper:RetainedEntityV2={version:2,entity,origin,observedSha256:hookDigest(JSON.stringify(observed))};updates.push({wrapper,mode});changed=true;
  }
  const nextReasons=[...reasons],assertions=b.unlinkedAssertions??v.data.unlinkedAssertions;
  if(JSON.stringify(nextReasons)!==JSON.stringify(v.data.reasons)||JSON.stringify(assertions)!==JSON.stringify(v.data.unlinkedAssertions))changed=true;
  if(!changed)return {status:"accepted",runId:v.row.run_id,entities:b.entities.length};if(v.data.revision>=999999)refuse("quota",507);
  v.data.revision++;v.data.reasons=nextReasons;v.data.unlinkedAssertions=assertions;v.contexts.set(next.contextKey,next);
  if(request.selector.kind==="main"){v.data.mainRevision=next.revision;v.row.incarnation_key=next.incarnationKey;v.row.source_cursor=next.transcriptCursor;v.row.prefix_bytes=next.prefixBytes;v.row.prefix_sha256=next.prefixSha256;v.row.observed_file_bytes=next.observedFileBytes;if(b.sessionClosureClaim)v.row.state="closed";}
  else {const id=agentIdentityV2(request.selector.agentId),i=v.data.agents.findIndex(t=>t[0]===id);if(i<0)refuse("corrupt",503);v.data.agents[i]=[id,next.incarnationKey,next.transcriptCursor,next.prefixBytes,next.prefixSha256,next.observedFileBytes,next.revision];}
  v.row.data=JSON.stringify(v.data);v.row.updated_at=Date.now();const digest=sessionDigestV2(v.row),contexts=contextMapV2(v.row,v.data);
  const root=[...v.entities.values()].find(item=>item.wrapper.entity.kind==="session");if(!root)refuse("corrupt",503);if(!updates.some(u=>u.wrapper.entity.kind==="session"))updates.push({wrapper:root.wrapper,mode:root.mode});
  this.writeSession(v.row);for(const update of updates){deadline();this.writeProjection(v.row,update.wrapper,update.mode,contexts,digest,v.row.updated_at);}
  this.store.db.query("UPDATE runs SET last_updated_at=? WHERE id=?").run(v.row.updated_at,v.row.run_id);this.verify(v.row.source_key,v.row.source_root_key,deadline);this.quota(deadline);return {status:"accepted",runId:v.row.run_id,entities:b.entities.length};
 }
}
