export type CaptureReason = "unsupported-event" | "missing-source-evidence" | "missing-roster" | "missing-chunk" | "duplicate-conflict" | "terminal-conflict" | "invalid-field" | "source-loss" | "receiver-loss" | "content-truncated" | "content-redacted" | "content-unavailable" | "metadata-conflict";
export interface RetrievalCapture { kind: "retrieval"; collection: string | null; topK: number | null; filter: string | null; resultCount: number | null; querySummary: string | null; queryText: string | null }
export interface EmbeddingCapture { kind: "embedding"; model: string | null; dimensions: number | null; inputText: string | null }
export interface StreamCapture {
  requested: boolean | null; state: "completed" | "cancelled" | "error" | "incomplete" | "unknown";
  reportedTerminal: "completed" | "cancelled" | "error" | null; coverage: "complete" | "partial" | "unavailable";
  chunks: Array<{ sequence: number; sourceEventIndex: number; timeUnixNano: string | null; text: string | null }>;
  observedChunkCount: number; duplicateChunkCount: number; declaredChunkCount: number | null;
  timeToFirstChunkMs: number | null; timePerOutputChunkMs: number | null; finishReasons: string[]; reasons: CaptureReason[];
}
export interface CaptureVisibilityV1 {
  schemaVersion: 1;
  source: { traceId: string | null; spanId: string | null; scopeName: string | null; scopeVersion: string | null; kindSource: string | null };
  retrieval: RetrievalCapture | null; embedding: EmbeddingCapture | null; stream: StreamCapture | null;
  usage: { cacheReadInputTokens: number | null; cacheCreationInputTokens: number | null; reasoningOutputTokens: number | null };
  coverage: { reasons: CaptureReason[]; receiverDroppedEvents: number; exporterDroppedEvents: number | null; receiverDroppedAttributes: number; exporterDroppedAttributes: number | null; invalidValues: number; truncatedValues: number; redactedValues: number };
}
