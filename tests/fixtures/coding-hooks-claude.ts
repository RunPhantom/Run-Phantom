import { createHash } from "node:crypto";
import type { TranscriptSnapshot } from "../../src/coding-hooks/claude";

/** Synthetic layouts pinned to the reviewed transcript source; these are not a real model session. */
export const hookSession = "11111111-1111-4111-8111-111111111111";
export const hookSourceKey = "a".repeat(64);
export const hookFixture = (event: string, fields: Record<string, unknown> = {}) => JSON.stringify({
  session_id: hookSession, hook_event_name: event, source: "startup", transcript_path: `/private/fixture/projects/project/${hookSession}.jsonl`, ...fields,
});
export const transcriptRecord = (fields: Record<string, unknown> = {}) => ({
  type: "assistant", uuid: "record_1", sessionId: hookSession, version: "2.1.296", timestamp: "2026-10-12T03:00:00.000Z", requestId: "request_1",
  message: { id: "msg_1", model: "fixture-model", content: [{ type: "text", text: "safe exact business result" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 2 } }, ...fields,
});
export function transcriptSnapshot(records: unknown[], tail = "", startOffset = 0): TranscriptSnapshot {
  const text = records.map(value => typeof value === "string" ? value : JSON.stringify(value)).map(line => line + "\n").join("") + tail;
  const bytes = Buffer.byteLength(text, "utf8");
  const prefixBytes = Math.min(bytes, 65536);
  return { text, fileBytes: startOffset + bytes, startOffset, endOffset: startOffset + bytes, incarnationKey: "b".repeat(64), prefixBytes, prefixSha256: prefixBytes ? createHash("sha256").update(Buffer.from(text).subarray(0, prefixBytes)).digest("hex") : null };
}
