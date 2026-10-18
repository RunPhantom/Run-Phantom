import type { CodingHookStore } from "./store";
import { hookDigest, isHex, refuse } from "./protocol";
import { parseBoundedHookJson } from "./shared";
import { contextEntityProjection } from "./context-projection";
import { readCompleteSession, validateSessionColumns, validateLegacySource, readCanonical, CANONICAL_COLUMNS, type CompleteSessionRow } from "./retained-version";
import { contextKeyV2, descriptorV2, retainedSessionV2, retainedEntityV2, sessionDigestV2, type DescriptorStateV2, type RetainedSessionV2, type RetainedEntityV2 } from "./context-v2";

interface CacheRow {entity_key:string;span_id:string;kind:string;phase:string;incarnation_key:string|null;source_offset:number|null;observation_sha256:string;projection_sha256:string;data:string;updated_at:number;}
export interface Verified {row:CompleteSessionRow;data:RetainedSessionV2;contexts:Map<string,DescriptorStateV2>;entities:Map<string,{row:CacheRow;wrapper:RetainedEntityV2;mode:"metadata"|"full"}>;digest:string;}
export function contextMapV2(row:CompleteSessionRow,data:RetainedSessionV2):Map<string,DescriptorStateV2> {
 const map=new Map<string,DescriptorStateV2>(),main=descriptorV2({contextKey:contextKeyV2(row.source_key,{kind:"main"}),incarnationKey:row.incarnation_key,transcriptCursor:row.source_cursor,prefixBytes:row.prefix_bytes,prefixSha256:row.prefix_sha256,observedFileBytes:row.observed_file_bytes,revision:data.mainRevision});map.set(main.contextKey,main);
 for(const t of data.agents){const key=hookDigest(JSON.stringify([row.source_key,"agent",t[0]]));map.set(key,descriptorV2({contextKey:key,incarnationKey:t[1],transcriptCursor:t[2],prefixBytes:t[3],prefixSha256:t[4],observedFileBytes:t[5],revision:t[6]}));}return map;
}
/** Shared read-only witnesses and quota for both transports on the same owned transaction. */
export function verifyContextSource(store:Pick<CodingHookStore,"db">,key:string,registration:string,deadline:()=>void):Verified {
  const row=readCompleteSession(store.db,key);if(!row)refuse("corrupt",503);if(row.state==="suppressed")refuse("suppressed");validateSessionColumns(row,key,registration);
  const data=retainedSessionV2(row.data),contexts=contextMapV2(row,data),digest=sessionDigestV2(row);
  if(!store.db.query("SELECT 1 FROM runs WHERE id=?").get(row.run_id))refuse("corrupt",503);
  const rows=store.db.query("SELECT entity_key,span_id,kind,phase,incarnation_key,source_offset,observation_sha256,projection_sha256,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data,updated_at FROM coding_hook_entities WHERE source_key=? ORDER BY entity_key LIMIT 1001").all(key) as CacheRow[];
  if(rows.length>1000)refuse("quota",507);const entities:Verified["entities"]=new Map();let roots=0;const spanIds=new Set<string>();
  for(const cached of rows){deadline();const wrapper=retainedEntityV2(cached.data,key,contexts),e=wrapper.entity,span=e.kind==="session"?row.root_span_id:e.entityKey.slice(0,16);
   if(cached.entity_key!==e.entityKey||cached.span_id!==span||cached.kind!==e.kind||cached.phase!==e.phase||cached.incarnation_key!==e.incarnationKey||cached.source_offset!==e.sourceOffset||cached.observation_sha256!==wrapper.observedSha256||!isHex(cached.projection_sha256,64))refuse("corrupt",503);
   const canonical=readCanonical(store.db,row.run_id,span);if(!canonical||hookDigest(JSON.stringify(canonical))!==cached.projection_sha256)refuse("corrupt",503);
   const a=parseBoundedHookJson(canonical.attributes,16384);if(a.status!=="accepted"||!a.value||typeof a.value!=="object"||Array.isArray(a.value)||(a.value.currentCapturePolicy!=="full"&&a.value.currentCapturePolicy!=="metadata"))refuse("corrupt",503);
   const mode=a.value.currentCapturePolicy;if(JSON.stringify(contextEntityProjection(cached.data,key,{runId:row.run_id,rootSpanId:row.root_span_id},mode,contexts,e.kind==="session"?digest:null))!==JSON.stringify(canonical))refuse("corrupt",503);
   if(e.kind==="session"){roots++;if(e.sourceKind!=="hook"||e.model!==null||e.body!==null||e.usage!==null||e.phase!==(row.state==="closed"?"complete":"pending"))refuse("corrupt",503);}
   entities.set(e.entityKey,{row:cached,wrapper,mode});spanIds.add(span);
  }
  if(roots!==1)refuse("corrupt",503);
  const spans=store.db.query("SELECT id,CASE WHEN length(CAST(attributes AS BLOB))<=16384 THEN attributes END attributes FROM spans WHERE run_id=? AND CASE WHEN json_valid(attributes) THEN json_extract(attributes,'$.source')='claude_hook' OR json_extract(attributes,'$.captureContract') LIKE 'runphantom.claude-hook.observation/%' ELSE attributes LIKE '%runphantom.claude-hook.observation/%' END LIMIT 1001").all(row.run_id) as {id:string;attributes:string|null}[];
  if(spans.length>1000)refuse("quota",507);for(const span of spans){deadline();if(!spanIds.has(span.id))refuse("corrupt",503);}
  return {row,data,contexts,entities,digest};
 }
export function assertHookCanonicalQuota(store:Pick<CodingHookStore,"db"|"assertContextQuota">,deadline:()=>void):void {
  const sources=store.db.query("SELECT DISTINCT source_key FROM coding_hook_entities LIMIT 100001").all() as {source_key:string}[];if(sources.length>100000)refuse("quota",507);let bytes=0;
  for(const source of sources){deadline();const session=readCompleteSession(store.db,source.source_key);if(!session)refuse("corrupt",503);const version=validateLegacySource(store.db,source.source_key,session.source_root_key);if(version==="context-v2")verifyContextSource(store,source.source_key,session.source_root_key,deadline);
   const spans=store.db.query(`SELECT DISTINCT ${CANONICAL_COLUMNS.map(c=>`s.${c}`).join(",")} FROM spans s JOIN coding_hook_entities e ON s.run_id=? AND e.source_key=? AND s.id=e.span_id LIMIT 1001`).all(session.run_id,source.source_key) as Record<string,unknown>[];if(spans.length>1000)refuse("quota",507);for(const span of spans){deadline();bytes+=Buffer.byteLength(JSON.stringify(span));}}
  store.assertContextQuota(bytes);
 }
