import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { freezeExecution, parseExecutionDraft, executeFrozen, DispatchSlots } from "../../src/evaluations/executor";
import { registeredExecutionDispatcher } from "../../src/evaluations/execution-endpoint";
import { ExecutionStore, EXECUTION_STORAGE_SQL } from "../../src/evaluations/execution-store";

// Controlled synthetic private native registration. No provider or host profile is consulted.
const state=path.join(os.homedir(),".runphantom");fs.mkdirSync(state,{mode:0o700});
fs.writeFileSync(path.join(state,"agents.json"),JSON.stringify({native:{url:`http://127.0.0.1:${Number(Bun.argv[2])}/replay`}}),{mode:0o600});
const policy={version:1,enabled:true,endpoints:[{endpointName:"native",revision:"1",enabled:true,costAccount:"free-fixture",costMode:"free_local",maximumAttemptMicrousd:0,maximumTotalMicrousd:0,maximumOutputTokens:256,maximumIterations:1}]};
const policyPath=path.join(state,"dataset-execution-policy.json");fs.writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});
const execution=freezeExecution({datasetId:"dataset",datasetName:"Synthetic controlled execution",version:1,hash:"a".repeat(64),createdAt:1,cases:[{id:"case",name:"Literal",input:"$& ${literal} <img src=x>",sourceRunId:null,sourceSpanId:null,sourceOutput:null,tags:[],rules:[{kind:"output",operation:"equals",value:"ok"}],sourceCapturedAt:null,sourceRedacted:false,sourceTruncated:false,sourceSnapshotVersion:null}]},parseExecutionDraft({datasetId:"dataset",version:1,datasetHash:"a".repeat(64),endpointName:"native",operationKey:"private-native-control",allowSideEffects:true}));
const endpoint=registeredExecutionDispatcher("native",execution.id);
const db=new Database(process.env.RUNPHANTOM_DB_PATH!);db.exec("PRAGMA foreign_keys=ON");db.exec(EXECUTION_STORAGE_SQL);
// Isolated fixture authority; no production owner/restart qualification claim.
const store=new ExecutionStore(db,{assertCurrent(){}});const receipt=store.admit(execution,{costAccount:endpoint.policy.costAccount,policyDigest:endpoint.policyDigest,maximumAttemptMicrousd:0,maximumTotalMicrousd:0});
const result=await executeFrozen(execution,async(...args)=>{if(!store.begin(execution.id,args[2].id,receipt.token))return {status:"unavailable",runId:null,actualCostUsd:null};return endpoint.dispatch(...args);},{slots:new DispatchSlots(),publish:value=>{store.publish(value,receipt.token);}});
policy.endpoints[0].revision="2";fs.writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});
const afterRevocation=await endpoint.dispatch(execution.request,execution.cases[0],execution.cases[0].attempts[0],new AbortController().signal);
policy.endpoints[0].costMode="guarded_paid";fs.writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});let paidRefused=false;try{registeredExecutionDispatcher("native",execution.id);}catch{paidRefused=true;}
const stored=store.get(result.id);db.close();process.stdout.write(JSON.stringify({execution:stored,afterRevocation,paidRefused}));
