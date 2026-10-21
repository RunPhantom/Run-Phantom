import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseDatasetExport, parseDatasetUpdate } from "../evaluations/validation";
import { parseTrialSelection } from "../evaluations/trials";
import { EVIDENCE_LIMITS, EvidenceError } from "../evaluations/evidence-protocol";
import { evidenceArray, evidenceObject, evidenceText, parseEvidenceImportRequest } from "../evaluations/evidence-validation";
import { EVIDENCE_HEADER_BYTES, EVIDENCE_IMPORT_CONTENT_TYPE } from "../evaluations/evidence-import";
import { readBoundedStream } from "../evaluations/evidence-worker";

const text = { type: "string", minLength: 1, maxLength: 128 };
const version = { type: "integer", minimum: 1, maximum: 20 };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const rule = { oneOf: [
  object({ kind: { const: "output" }, operation: { enum: ["equals", "contains", "notContains"] }, value: { type: "string", maxLength: 4096 } }, ["kind", "operation", "value"]),
  object({ kind: { const: "json" } }, ["kind"]),
  object({ kind: { const: "jsonPath" }, path: { type: "string", maxLength: 1024 }, equals: {} }, ["kind", "path", "equals"]),
  object({ kind: { const: "tools" }, operation: { enum: ["required", "forbidden", "sequence"] }, names: { type: "array", minItems: 1, maxItems: 20, items: text } }, ["kind", "operation", "names"]),
  object({ kind: { const: "toolArgument" }, name: text, path: { type: "string", maxLength: 1024 }, equals: {}, match: { enum: ["any", "all"], description: "any requires a proven matching call; all requires every named call to match. Zero calls fail; unavailable evidence remains inconclusive." } }, ["kind", "name", "path", "equals", "match"]),
  object({ kind: { const: "budget" }, metric: { enum: ["inputTokens", "outputTokens", "totalTokens", "durationMs", "costUsd", "toolCalls"] }, max: { type: "number", minimum: 0 } }, ["kind", "metric", "max"]),
  object({ kind: { const: "errors" }, max: { type: "integer", minimum: 0 } }, ["kind", "max"]),
  object({ kind: { const: "rubric" }, provider: { enum: ["openai", "anthropic"] }, model: text, rubric: { type: "string", minLength: 1, maxLength: 2000 }, threshold: { type: "number", minimum: 0, maximum: 1 } }, ["kind", "provider", "model", "rubric", "threshold"]),
] };
const cases = { type: "array", maxItems: 50, items: object({ id: text, name: text, input: { type: "string", maxLength: 16384 }, sourceRunId: text, sourceSpanId: text, tags: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 64 } }, rules: { type: "array", minItems: 1, maxItems: 8, items: rule } }, ["name", "rules"]) };
const portable = object({ format: { const: "runphantom-evaluations/v1" }, name: text, cases }, ["format", "name", "cases"]);

export const EVALUATION_TOOLS: Tool[] = [
  { name: "eval_evidence", description: "Import bounded report bytes into an existing local run/experiment/check, edit a separate anchored inventory with CAS, poll/cancel durable jobs, export minimized observations, explicitly download raw bytes, reparse retained own bytes or remove raw/normalized retention separately. Imports use the same versioned binary HTTP transport and actual daemon queue. No server paths or URLs. Attestation assertions are unverified; unknown observations never prove execution. Upload UI and team scope are separate features.", inputSchema: { type: "object", required: ["action"], additionalProperties: false, properties: {
    action: { enum: ["import", "status", "cancel", "inventory_get", "inventory_edit", "report", "raw", "reparse", "retention_delete"] },
    request: { type: "object" }, sources: { type: "array", minItems: 1, maxItems: 32, items: object({ sourceId: text, base64: { type: "string", maxLength: 2_796_204 } }, ["sourceId", "base64"]) },
    jobId: text, operationKey: text, setId: text, sourceId: text, revision: { type: "integer", minimum: 1 }, anchor: { type: "object" },
    expectedRevision: { type: "integer", minimum: 0 }, expected: { type: "array", minItems: 1, maxItems: 32 }, inventory: { type: ["object", "null"] },
    retention: { enum: ["raw_and_normalized", "normalized_only"] }, kind: { enum: ["raw", "normalized"] },
  } } },
  { name: "eval_dataset", description: "List/get/create/update/import/export/delete versioned regression datasets. Create requires name. Update requires datasetId, expectedVersion and complete cases; concurrent or stale revisions return409. Each case requires explicit rules; sourceRunId/sourceSpanId captures reference input/output, and input is an explicit manual override. Import data is the portable format and never restores trusted source identities. Deletion retains frozen experiment history. No executable evaluators.", inputSchema: { type: "object", required: ["action"], properties: { action: { enum: ["list", "get", "create", "update", "import", "export", "delete"] }, datasetId: text, name: text, version, expectedVersion: version, cases, data: portable }, additionalProperties: false } },
  { name: "eval_run", description: "Snapshot a captured run, start an evaluation experiment, list/get jobs or cancel a job. analyze requires 2–20 distinct experimentIds with identical frozen definitions and distinct captured runs per case; returns observed outcomes and unresolved bounds, not a confidence interval, without rerunning anything. snapshot requires runId and optional outputSpanId. report requires experimentId and optional compatible baseline; returns a compact JSON report with a strict gate, without raw payloads or model explanations. start requires datasetId,name and assignments mapping EVERY revision case once to a captured candidate run. Inputs must match exactly except CRLF normalization; mismatch/unavailable yields inconclusive without model calls. Returns frozen pending/running results and a job id immediately; poll get until terminal. Model rubric calls require explicit allowModelJudges:true consent and send selected trace data externally. Omitted consent never authorizes model calls. This does not replay agents.", inputSchema: { type: "object", required: ["action"], properties: { action: { enum: ["snapshot", "start", "get", "list", "cancel", "report", "analyze"] }, experimentIds: { type: "array", minItems: 2, maxItems: 20, uniqueItems: true, items: text }, baseline: text, runId: text, outputSpanId: text, experimentId: text, datasetId: text, version, name: text, assignments: { type: "array", minItems: 1, maxItems: 50, items: object({ caseId: text, runId: text, outputSpanId: text }, ["caseId", "runId"]) }, allowModelJudges: { type: "boolean" } }, additionalProperties: false } },
  { name: "eval_compare", description: "Compare completed baseline and candidate experiments from the SAME dataset id/revision/hash, case membership and evaluator versions. Returns per-case regressions/improvements/inconclusive and candidate-minus-baseline token/duration/reported-cost deltas. Unknown metrics stay null. Incompatible experiments fail instead of weakening the comparison.", inputSchema: { type: "object", required: ["baseline", "candidate"], properties: { baseline: text, candidate: text }, additionalProperties: false } },
  { name: "eval_review", description: "List append-only human reviews or create a human pass/fail review for a case in an experiment. Human reviews are separate from code/model verdicts and never overwrite automatic scores. create requires experimentId,caseId,rating and optional note.", inputSchema: { type: "object", required: ["action", "experimentId"], properties: { action: { enum: ["list", "create"] }, experimentId: text, caseId: text, rating: { enum: ["pass", "fail"] }, note: { type: "string", maxLength: 2000 } }, additionalProperties: false } },
];

function required(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new McpError(ErrorCode.InvalidParams, `${name} must be a nonempty string of at most 128 characters`);
  return value;
}
function optionalVersion(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) throw new McpError(ErrorCode.InvalidParams, `${name} must be a revision number from 1 to 20`);
  return value;
}
async function request(url: string, path: string, method = "GET", body?: unknown) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new McpError(ErrorCode.InvalidParams, "Evaluation request exceeds 2 MiB");
  let response: Response;
  try { response = await fetch(`${url.replace(/\/$/, "")}/api/evaluations${path}`, { method, headers: encoded ? { "Content-Type": "application/json" } : undefined, body: encoded }); }
  catch { throw new McpError(ErrorCode.InternalError, "Run Phantom is unreachable. Start the local daemon and retry."); }
  if (response.status === 204) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `Evaluation request failed (${response.status})`;
    throw new McpError(response.status < 500 ? ErrorCode.InvalidParams : ErrorCode.InternalError, error);
  }
  if (value === null) throw new McpError(ErrorCode.InternalError, "Run Phantom returned an invalid evaluation response");
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function datasetRequestBody(value: unknown, portable = false) {
  try { return portable ? parseDatasetExport(value) : parseDatasetUpdate(value); }
  catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "Invalid evaluation dataset"); }
}

export async function callEvaluationTool(name: string, args: Record<string, unknown>, backendUrl: string) {
  const tool = EVALUATION_TOOLS.find(item => item.name === name);
  if (!tool) return undefined;
  if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties ?? {}, key))) throw new McpError(ErrorCode.InvalidParams, "Unexpected evaluation argument");
  const id = (key: string) => encodeURIComponent(required(args, key));
  switch (name) {
    case "eval_evidence": return callEvidenceTool(args, backendUrl);
    case "eval_dataset": {
      switch (args.action) {
        case "list": return request(backendUrl, "/datasets");
        case "create": return request(backendUrl, "/datasets", "POST", { name: required(args, "name") });
        case "get": case "export": {
          const revision = optionalVersion(args, "version");
          return request(backendUrl, `/datasets/${id("datasetId")}${args.action === "export" ? "/export" : ""}${revision === undefined ? "" : `?version=${revision}`}`);
        }
        case "update": {
          const expectedVersion = optionalVersion(args, "expectedVersion");
          if (expectedVersion === undefined || !Array.isArray(args.cases)) throw new McpError(ErrorCode.InvalidParams, "expectedVersion and cases are required");
          return request(backendUrl, `/datasets/${id("datasetId")}`, "PUT", datasetRequestBody({ expectedVersion, cases: args.cases }));
        }
        case "import": {
          if (!args.data || typeof args.data !== "object" || Array.isArray(args.data)) throw new McpError(ErrorCode.InvalidParams, "data must be a portable dataset object");
          return request(backendUrl, "/datasets/import", "POST", datasetRequestBody(args.data, true));
        }
        case "delete": return request(backendUrl, `/datasets/${id("datasetId")}`, "DELETE");
        default: throw new McpError(ErrorCode.InvalidParams, "action must be list/get/create/update/import/export/delete");
      }
    }
    case "eval_run": {
      switch (args.action) {
        case "analyze": {
          let experimentIds: string[];
          try { experimentIds = parseTrialSelection({ experimentIds: args.experimentIds }); }
          catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "Invalid trial selection"); }
          return request(backendUrl, "/analyses/repeated-trials", "POST", { experimentIds });
        }
        case "list": return request(backendUrl, "/experiments");
        case "snapshot": return request(backendUrl, `/runs/${id("runId")}/snapshot${args.outputSpanId === undefined ? "" : `?outputSpanId=${id("outputSpanId")}`}`);
        case "get": return request(backendUrl, `/experiments/${id("experimentId")}`);
        case "report": return request(backendUrl, `/experiments/${id("experimentId")}/report${args.baseline === undefined ? "" : `?${new URLSearchParams({ baseline: required(args, "baseline") })}`}`);
        case "cancel": return request(backendUrl, `/experiments/${id("experimentId")}/cancel`, "POST");
        case "start": {
          if (!Array.isArray(args.assignments) || !args.assignments.length) throw new McpError(ErrorCode.InvalidParams, "assignments must map every case to a candidate run");
          if (args.allowModelJudges !== undefined && typeof args.allowModelJudges !== "boolean") throw new McpError(ErrorCode.InvalidParams, "allowModelJudges must be boolean");
          return request(backendUrl, "/experiments", "POST", { datasetId: required(args, "datasetId"), name: required(args, "name"), version: optionalVersion(args, "version"), assignments: args.assignments, ...(args.allowModelJudges === undefined ? {} : { allowModelJudges: args.allowModelJudges }) });
        }
        default: throw new McpError(ErrorCode.InvalidParams, "action must be snapshot/start/get/list/cancel/report/analyze");
      }
    }
    case "eval_compare": return request(backendUrl, `/compare?${new URLSearchParams({ baseline: required(args, "baseline"), candidate: required(args, "candidate") })}`);
    case "eval_review": {
      const experimentId = id("experimentId");
      if (args.action === "list") return request(backendUrl, `/experiments/${experimentId}/reviews`);
      if (args.action !== "create" || (args.rating !== "pass" && args.rating !== "fail") || (args.note !== undefined && (typeof args.note !== "string" || args.note.length > 2000))) throw new McpError(ErrorCode.InvalidParams, "create requires rating pass/fail and an optional note up to 2000 characters");
      return request(backendUrl, `/experiments/${experimentId}/reviews`, "POST", { caseId: required(args, "caseId"), rating: args.rating, note: args.note });
    }
  }
}

async function callEvidenceTool(args: Record<string, unknown>, backendUrl: string) {
  try {
    const fields: Record<string, string[]> = { import: ["request", "sources"], status: ["jobId", "operationKey"], cancel: ["jobId"],
      inventory_get: ["anchor", "revision"], inventory_edit: ["anchor", "expectedRevision", "expected"], report: ["setId", "revision"], raw: ["setId", "sourceId", "revision"],
      reparse: ["setId", "operationKey", "expectedRevision", "inventory", "retention"], retention_delete: ["setId", "revision", "kind"] };
    args = evidenceObject(args, ["action", ...new Set(Object.values(fields).flat())], "evidence arguments");
    if (typeof args.action !== "string" || !Object.hasOwn(fields, args.action)) throw new EvidenceError("Unsupported evidence action");
    evidenceObject(args, ["action", ...fields[args.action]], "evidence action");
    const id = (key: string) => encodeURIComponent(evidenceText(args[key], key));
    const rev = (required = false) => {
      if (args.revision === undefined && !required) return "";
      if (!Number.isSafeInteger(args.revision) || (args.revision as number) < 1) throw new EvidenceError("Evidence revision must be a positive integer");
      return `?revision=${args.revision as number}`;
    };
    if (args.action === "import") {
      const draft = parseEvidenceImportRequest(args.request), sourceValues = evidenceArray(args.sources, EVIDENCE_LIMITS.MAX_REPORTS, "raw sources", 1);
      if (sourceValues.length !== draft.sources.length) throw new EvidenceError("Raw sources require the exact declared roster");
      const raw = sourceValues.map((value, index) => {
        const source = evidenceObject(value, ["sourceId", "base64"], "raw source"), descriptor = draft.sources[index];
        if (source.sourceId !== descriptor.sourceId || typeof source.base64 !== "string" || source.base64.length > Math.ceil(descriptor.byteLength / 3) * 4) throw new EvidenceError("Raw source requires bounded canonical base64 in declared order");
        const bytes = Buffer.from(source.base64, "base64");
        if (bytes.byteLength !== descriptor.byteLength || bytes.toString("base64") !== source.base64) throw new EvidenceError("Raw source bytes do not match their declared length");
        return bytes;
      });
      const metadata = Buffer.from(JSON.stringify({ version: 1, request: draft }));
      if (metadata.byteLength > EVIDENCE_HEADER_BYTES) throw new EvidenceError("Evidence metadata exceeds 64 KiB", 413);
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.byteLength);
      return evidenceRequest(backendUrl, "/imports", "POST", Buffer.concat([prefix, metadata, ...raw]), EVIDENCE_IMPORT_CONTENT_TYPE);
    }
    if (args.action === "status") {
      if ((args.jobId === undefined) === (args.operationKey === undefined)) throw new EvidenceError("Status requires exactly one jobId or operationKey");
      return evidenceRequest(backendUrl, args.jobId === undefined ? `/imports?${new URLSearchParams({ operationKey: evidenceText(args.operationKey, "operation key") })}` : `/imports/${id("jobId")}`);
    }
    if (args.action === "cancel") return evidenceRequest(backendUrl, `/imports/${id("jobId")}/cancel`, "POST", {});
    if (args.action === "inventory_get") return evidenceRequest(backendUrl, `/inventories?${new URLSearchParams({ anchor: JSON.stringify(args.anchor), revision: String(args.revision) })}`);
    if (args.action === "inventory_edit") return evidenceRequest(backendUrl, "/inventories", "PUT", { anchor: args.anchor, expectedRevision: args.expectedRevision, expected: args.expected });
    if (args.action === "report") return evidenceRequest(backendUrl, `/sets/${id("setId")}/export${rev()}`);
    if (args.action === "raw") return evidenceRequest(backendUrl, `/sets/${id("setId")}/raw/${id("sourceId")}${rev(true)}`, "GET", undefined, undefined, true);
    if (args.action === "reparse") return evidenceRequest(backendUrl, `/sets/${id("setId")}/reparse`, "POST", { operationKey: args.operationKey, expectedRevision: args.expectedRevision,
      ...(Object.hasOwn(args, "inventory") ? { inventory: args.inventory } : {}), ...(Object.hasOwn(args, "retention") ? { retention: args.retention } : {}) });
    if (args.kind !== "raw" && args.kind !== "normalized") throw new EvidenceError("Retention kind must be raw or normalized");
    return evidenceRequest(backendUrl, `/sets/${id("setId")}/retention/${args.kind}${rev(true)}`, "DELETE", {});
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InvalidParams, error instanceof EvidenceError ? error.message : "Invalid evidence action");
  }
}
async function evidenceRequest(url: string, path: string, method = "GET", body?: unknown, contentType?: string, raw = false) {
  const binary = Buffer.isBuffer(body), encoded = binary ? body : body === undefined ? undefined : JSON.stringify(body);
  if (typeof encoded === "string" && Buffer.byteLength(encoded) > EVIDENCE_HEADER_BYTES) throw new EvidenceError("Evidence controls exceed 64 KiB", 413);
  let response: Response;
  try { response = await fetch(`${url.replace(/\/$/, "")}/api/evaluations/evidence${path}`, { method, headers: encoded === undefined ? undefined : { "Content-Type": contentType ?? "application/json" }, body: encoded as BodyInit | undefined }); }
  catch { throw new McpError(ErrorCode.InternalError, "Run Phantom is unreachable. Start the local daemon and retry."); }
  let bytes: Uint8Array;
  try { bytes = await readBoundedStream(response.body!, raw && response.ok ? EVIDENCE_LIMITS.MAX_SOURCE_BYTES : EVIDENCE_LIMITS.MAX_IMPORT_BYTES); }
  catch { throw new McpError(ErrorCode.InternalError, "Run Phantom returned an oversized or interrupted evidence response"); }
  if (raw && response.ok) return { content: [{ type: "text" as const, text: JSON.stringify({ format: "runphantom-raw-evidence/v1", bytesBase64: Buffer.from(bytes).toString("base64") }) }] };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new McpError(ErrorCode.InternalError, "Run Phantom returned an invalid evidence response"); }
  if (!response.ok) throw new McpError(response.status < 500 ? ErrorCode.InvalidParams : ErrorCode.InternalError,
    value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Evidence request failed");
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
