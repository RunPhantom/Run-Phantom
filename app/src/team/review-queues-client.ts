import { TeamApiError, TeamClient, projectApi, teamQuery, type Page } from "../api/team";
import { REVIEW_LIMITS as L, type PromotionRequest, type ReviewCounts, type ReviewItem, type ReviewItemSummary, type ReviewMutation, type ReviewSchema } from "../../../src/review-queues/protocol";
import type { DatasetExport } from "../../../src/evaluations/protocol";
import type { TeamReviewQueue, TeamReviewItem, TeamReviewDataset, TeamReviewDatasetRevision, TeamReviewReceipt } from "../../../src/team/review-queue-protocol";
import { ReviewRequestError } from "../components/review-queues/client";
export type { TeamReviewQueue, TeamReviewItem, TeamReviewDataset, TeamReviewDatasetRevision, TeamReviewReceipt };
export type TeamReviewPage = Page<ReviewItemSummary> & {counts: ReviewCounts};
const invalid = () => new TeamApiError(502,"invalid_response","The project review response is unavailable or exceeds its bounds.");
const uuid = (value: string) => { if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new TeamApiError(400,"invalid_request","Choose a project review resource.");return value; };
const digest = (value: string) => { if(!/^[a-f0-9]{64}$/.test(value)) throw new TeamApiError(400,"invalid_request","Choose a project review item.");return value; };
const revision = (value: number) => { if(!Number.isSafeInteger(value)||value<1) throw new TeamApiError(400,"invalid_request","Choose a positive review revision.");return value; };
function counts(value: ReviewCounts) {
  if(!value||Object.keys(value).sort().join(",")!=="approved,draft,promoted,total"||Object.values(value).some(n=>!Number.isSafeInteger(n)||n<0)
    ||value.total>L.MAX_ITEMS_PER_QUEUE||value.total!==value.draft+value.approved+value.promoted) throw invalid();
}
/** Concrete browser projection for the existing source-free draft controller. No backend runtime import. */
export function teamDraftItem(item: TeamReviewItem): ReviewItem {
  const {projectId:_projectId,projectSourceHash:_projectSourceHash,approvalWitness:_witness,reviewSource,...core}=item;
  return {...core,reviewSource:reviewSource==="projectAccount"?"localOperator":null};
}
export function teamReviewApi(client: TeamClient, projectId: string) {
  const base=projectApi(uuid(projectId)), queues=base+"/review-queues", datasets=base+"/review-datasets";
  const at=(id:string)=>`${queues}/${uuid(id)}`;
  const full=(item:TeamReviewItem,queue:string)=> {
    if(!item||item.projectId!==projectId||item.queueId!==queue||!item.id||![null,"projectAccount"].includes(item.reviewSource))throw invalid();
    digest(item.id);revision(item.revision);return item;
  };
  return {
    async queues(){const rows=await client.reviews<Array<TeamReviewQueue&{counts:ReviewCounts}>>(queues);if(!Array.isArray(rows)||rows.length>L.MAX_QUEUES)throw invalid();for(const row of rows){if(row.projectId!==projectId)throw invalid();uuid(row.id);counts(row.counts);}return rows;},
    create:(name:string,schema?:ReviewSchema)=>client.reviews<TeamReviewQueue>(queues,{method:"POST",body:{name,...(schema?{schema}:{})}}),
    deleteQueue:(id:string)=>client.reviews<void>(at(id),{method:"DELETE"}),
    async insert(queue:string,runId:string,outputSpanId?:string){return full(await client.reviews<TeamReviewItem>(at(queue)+"/items",{method:"POST",body:{runId,...(outputSpanId?{outputSpanId}:{})}}),queue);},
    async page(queue:string,cursor?:string){const page=await client.reviews<TeamReviewPage>(at(queue)+"/items"+teamQuery({limit:50,cursor}));
      if(!page||Object.keys(page).sort().join(",")!=="counts,hasMore,items,nextCursor"||typeof page.hasMore!=="boolean"
        ||page.nextCursor!==null&&(typeof page.nextCursor!=="string"||page.nextCursor.length>512||!/^[A-Za-z0-9_-]+$/.test(page.nextCursor)))throw invalid();
      counts(page.counts);if(!Array.isArray(page.items)||page.items.length>L.MAX_PAGE)throw invalid();for(const row of page.items){if(Object.keys(row).sort().join(",")!=="id,name,ordinal,revision,state")throw invalid();digest(row.id);revision(row.ordinal);revision(row.revision);if(typeof row.name!=="string"||row.name.length>128||!["draft","approved","promoted"].includes(row.state))throw invalid();}return page;},
    async window(queue:string,center:string){const rows=await client.reviews<TeamReviewItem[]>(at(queue)+"/window"+teamQuery({centerId:digest(center)}));if(!Array.isArray(rows)||rows.length>L.MAX_WINDOW)throw invalid();return rows.map(row=>full(row,queue));},
    async mutate(queue:string,id:string,kind:"save"|"approve"|"reopen",body:ReviewMutation){return full(await client.reviews<TeamReviewItem>(`${at(queue)}/items/${digest(id)}${kind==="save"?"":`/${kind}`}`,{method:kind==="save"?"PUT":"POST",body}),queue);},
    deleteItem:(queue:string,id:string,expectedRevision:number)=>client.reviews<void>(`${at(queue)}/items/${digest(id)}`+teamQuery({expectedRevision:revision(expectedRevision)}),{method:"DELETE"}),
    promote:(request:PromotionRequest)=>{const{queueId,...body}=request;return client.reviews<TeamReviewReceipt>(at(queueId)+"/promotions",{method:"POST",body});},
    datasets:()=>client.reviews<TeamReviewDataset[]>(datasets),
    deleteDataset:(id:string)=>client.reviews<void>(`${datasets}/${uuid(id)}`,{method:"DELETE"}),
    createDataset:(name:string)=>client.reviews<TeamReviewDatasetRevision>(datasets,{method:"POST",body:{name}}),
    getRevision:(id:string,version:number)=>client.reviews<TeamReviewDatasetRevision>(`${datasets}/${uuid(id)}/revisions/${revision(version)}`),
    exportRevision:(id:string,version:number)=>client.reviews<DatasetExport>(`${datasets}/${uuid(id)}/revisions/${revision(version)}/export`),
  };
}
export type TeamReviewApi=ReturnType<typeof teamReviewApi>;
export function teamDraftApi(api:TeamReviewApi,onStored:(item:TeamReviewItem)=>void) {
  return {
    async mutate(queue:string,id:string,kind:"save"|"approve"|"reopen",body:ReviewMutation) {
      try{const stored=await api.mutate(queue,id,kind,body);onStored(stored);return teamDraftItem(stored);}
      catch(error){if(error instanceof TeamApiError)throw new ReviewRequestError(error.message,error.status,error.code);throw error;}
    },
    async window(queue:string,center:string) {const items=await api.window(queue,center);for(const item of items)onStored(item);return items.map(teamDraftItem);},
  };
}
