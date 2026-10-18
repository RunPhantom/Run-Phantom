import { randomBytes } from "node:crypto";
import { CATALOG_CONTEXT_VERSION, encodeInstallationCatalog } from "./catalog";
import { ContextHookStore } from "./context-store";
import { type TransitionRequestV2 } from "./context-v2";
import { hookDigest, refuse } from "./protocol";
import { CodingHookStore } from "./store";

export interface ContextPauseGate {pause():void;drain():Promise<void>;resume(ownerGeneration:string,checkpoint:()=>void):void;}
type Installed = NonNullable<ReturnType<CodingHookStore["readInstallation"]>>;
export interface TransitionPlan {request:TransitionRequestV2;sourceEpoch:string;installations:Installed[];selected:Installed[];unchanged:boolean;}
export interface FencedTransition {plan:TransitionPlan;ownerGeneration:string;selected:{before:Installed;generation:string;token:string;catalog:string}[];}
/** Credentials returned here are trusted-management memory only and never transport responses. */
export class ContextTransitionStore {
 constructor(readonly store:CodingHookStore){}
 plan(request:TransitionRequestV2):TransitionPlan {
  return this.store.contextTransaction(()=>{
   if(this.store.currentOwnerGeneration()!==request.expectedOwnerGeneration)refuse("stale");
   const ids=this.store.db.query("SELECT id FROM coding_hook_installations ORDER BY id LIMIT 65").all() as {id:string}[];if(ids.length>64)refuse("quota",507);
   const installations=ids.map(({id})=>{const installed=this.store.readInstallation(id);if(!installed)refuse("corrupt",503);return installed;}),selected=request.installationIds.map(id=>{const installed=installations.find(value=>value.row.id===id);if(!installed)refuse("unknown_scope");return installed;});
   if(!selected.some(value=>value.row.state==="active"))refuse("inactive");
   const roots=new Set(selected.flatMap(value=>value.registrations.map(root=>root.registrationId)));
   if(installations.some(value=>!request.installationIds.includes(value.row.id)&&value.registrations.some(root=>roots.has(root.registrationId))))refuse("unknown_scope");
   for(let i=0;i<selected.length;i++){const current=selected[i],expected=request.expectedInstallations[i];if(current.row.generation!==expected.generation||current.row.config_sha256!==expected.configSha256||hookDigest(current.row.data!)!==expected.catalogSha256)refuse("stale");encodeInstallationCatalog(current.binding,current.registrations,CATALOG_CONTEXT_VERSION);}
   new ContextHookStore(this.store).assertCurrentQuota();
   const epoch=this.store.db.query("SELECT source_epoch FROM coding_hook_owner WHERE id=1").get() as {source_epoch:string};
   return {request,sourceEpoch:epoch.source_epoch,installations,selected,unchanged:selected.every(value=>value.catalogVersion===CATALOG_CONTEXT_VERSION)};
  });
 }
 fence(plan:TransitionPlan):FencedTransition {
  return this.store.contextTransaction(()=>{
   const current=this.plan(plan.request);if(current.sourceEpoch!==plan.sourceEpoch)refuse("stale");this.store.rotateOwner();const ownerGeneration=this.store.currentOwnerGeneration();
   const selected=current.selected.map(before=>{const generation=randomBytes(16).toString("hex"),token=randomBytes(32).toString("hex"),catalog=encodeInstallationCatalog(before.binding,before.registrations,CATALOG_CONTEXT_VERSION);
    this.store.db.query("UPDATE coding_hook_installations SET generation=?,token_sha256=?,state='disabled',data=?,updated_at=? WHERE id=?").run(generation,hookDigest(token),catalog,Date.now(),before.row.id);return {before,generation,token,catalog};});
   new ContextHookStore(this.store).assertCurrentQuota();return {plan:current,ownerGeneration,selected};
  });
 }
 checkpoint(fenced:FencedTransition,committed=false):void {
  if(this.store.currentOwnerGeneration()!==fenced.ownerGeneration)refuse("stale");const epoch=this.store.db.query("SELECT source_epoch FROM coding_hook_owner WHERE id=1").get() as {source_epoch:string};if(epoch.source_epoch!==fenced.plan.sourceEpoch)refuse("stale");
  for(const before of fenced.plan.installations){const installed=this.store.readInstallation(before.row.id);if(!installed)refuse("stale");const selected=fenced.selected.find(value=>value.before.row.id===before.row.id);
   if(selected){if(installed.row.generation!==selected.generation||installed.row.token_sha256!==hookDigest(selected.token)||installed.row.data!==selected.catalog||installed.row.config_sha256!==before.row.config_sha256||installed.row.state!==(committed?before.row.state:"disabled"))refuse("stale");}
   else if(JSON.stringify(installed)!==JSON.stringify(before))refuse("stale");
  }
  new ContextHookStore(this.store).assertCurrentQuota();
 }
 commit(fenced:FencedTransition):void {this.store.contextTransaction(()=>{this.checkpoint(fenced);for(const selected of fenced.selected)if(selected.before.row.state==="active")this.store.db.query("UPDATE coding_hook_installations SET state='active',updated_at=? WHERE id=?").run(Date.now(),selected.before.row.id);this.checkpoint(fenced,true);});}
 fail(fenced:FencedTransition):void {
  this.store.contextTransaction(()=>{this.store.rotateOwner();for(const selected of fenced.selected)this.store.db.query("UPDATE coding_hook_installations SET state='disabled',generation=?,token_sha256=?,updated_at=? WHERE id=?").run(randomBytes(16).toString("hex"),hookDigest(randomBytes(32).toString("hex")),Date.now(),selected.before.row.id);});
 }
}
