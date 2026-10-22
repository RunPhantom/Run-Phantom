// Inactive component fixture: synthetic transport states are not daemon/provider qualification.
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../src/index.css";
import { DatasetExecution, type DatasetExecutionClient } from "../src/components/evaluations/DatasetExecution";
import type { DatasetRevision } from "../../src/evaluations/protocol";
import type { DatasetExecution as Execution, ExecutionDraft } from "../../src/evaluations/execution-protocol";
const revision:DatasetRevision={datasetId:"fixture",datasetName:"Checkout regression",version:2,hash:"a".repeat(64),createdAt:1,cases:["First","Second","Third"].map((name,index)=>({id:`case-${index}`,name,input:"<img src=x onerror=alert(1)> ${literal}",sourceRunId:null,sourceSpanId:null,sourceOutput:null,tags:[],rules:[{kind:"output",operation:"equals",value:"ok"}],sourceCapturedAt:null,sourceRedacted:false,sourceTruncated:false,sourceSnapshotVersion:null}))};
let calls=0;let current:Execution|null=null;
const count=()=>{calls++;document.documentElement.dataset.fixtureCalls=String(calls);};
const client:DatasetExecutionClient={
 async capabilities(){count();return {enabled:new URLSearchParams(location.search).get("disabled")!=="1",endpoints:[{name:"Controlled local endpoint",available:true,reason:"Synthetic component transport; no provider calls.",maximumAttemptCostUsd:0}]};},
 async start(request:ExecutionDraft){count();current={format:"runphantom-dataset-execution/v1",kind:"registered_endpoint_execution",id:crypto.randomUUID(),requestDigest:"b".repeat(64),dataset:{id:revision.datasetId,name:revision.datasetName,version:revision.version,hash:revision.hash},request,createdAt:Date.now(),completedAt:null,status:"running",reservedCostUsd:0,cases:revision.cases.map(item=>({case:item,grading:{status:"inconclusive",checks:[],runId:null,reason:"Complete attributed capture is unavailable."},attempts:Array.from({length:request.maxAttempts},(_,index)=>({id:crypto.randomUUID(),index,status:index===0?"running":"not_started",startedAt:index===0?Date.now():null,completedAt:null,runId:null,actualCostUsd:null,reason:index===0?"Controlled pending transport":"Not dispatched",sideEffects:index===0?"may_have_occurred":"not_dispatched"}))}))};return structuredClone(current);},
 async get(){count();if(!current)throw new Error("Synthetic result missing");current.status="completed";current.completedAt=Date.now();for(const item of current.cases){item.attempts[0].status="transport_success";item.attempts[0].reason="HTTP transport completed; captured grading is separate.";}return structuredClone(current);},
 async cancel(){count();if(!current)throw new Error("Synthetic result missing");current.status="cancelled";current.completedAt=Date.now();for(const item of current.cases)for(const attempt of item.attempts){attempt.status="cancelled";attempt.reason="Stopped; external side effects may have occurred.";}return structuredClone(current);},
};
document.documentElement.dataset.fixtureCalls="0";
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-6xl space-y-5 p-5 text-[color:var(--rp-ink)]"><h1 style={{fontFamily:"var(--font-display)"}} className="text-xl font-semibold">Dataset execution component</h1><p className="text-xs">Controlled synthetic UI states. Native admission remains inactive.</p><DatasetExecution revision={revision} client={client}/></main>);
