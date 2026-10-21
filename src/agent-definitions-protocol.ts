/** Safe definition identities describe captured configuration, never executions or user queries. */
export const AGENT_DEFINITION_FORMAT = "runphantom-agent-definition/v1" as const;
export const AGENT_DEFINITION_CAPTURE_KEY = "runphantom.agent.definition";
export const AGENT_DEFINITION_LIMITS = { fieldBytes: 64 * 1024, records: 32, tools: 64, providers: 32, nodes: 5000, depth: 16, metadataBytes: 16 * 1024 } as const;
export const DEFINITION_COMPONENTS = ["prompt", "tools", "model", "providers", "runtime"] as const;
export type DefinitionComponent = typeof DEFINITION_COMPONENTS[number];
export type DefinitionAvailability = "available" | "missing" | "redacted" | "invalid" | "oversized" | "ambiguous" | "incomplete";
export interface DefinitionComponentEvidence { status: DefinitionAvailability; sha256: string | null }
export interface CapturedAgentDefinition {
  sourceSpanId: string | null;
  provenance: "explicit-v1" | "legacy-attributes";
  complete: boolean;
  semanticVersion: typeof AGENT_DEFINITION_FORMAT;
  sha256: string | null;
  components: Record<DefinitionComponent, DefinitionComponentEvidence>;
  reasons: Array<"capture_missing" | "capture_unavailable" | "capture_ambiguous" | "capture_invalid" | "capture_partial" | "capture_redacted" | "capture_oversized" | "source_receipt_missing" | "source_receipt_loss" | "source_identity_unavailable">;
}
export interface CapturedAgentDefinitions {
  format: "runphantom-agent-definitions/v1";
  records: CapturedAgentDefinition[];
  observedRecords: number;
  omittedRecords: number;
  unavailableAttributes: number;
  complete: boolean;
}
export interface DefinitionCaptureSpan {
  id: string;
  attributes: string | null;
  otlp_evidence?: string | null;
  attributes_oversized?: number;
  otlp_evidence_oversized?: number;
  unavailable?: { attributes: boolean; input?: boolean; output?: boolean; otlpEvidence?: boolean };
}
