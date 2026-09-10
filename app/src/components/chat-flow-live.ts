export function shouldRenderTextDelta({
  isActive,
  eventTimestamp,
  completedLLMEndTimes,
}: {
  isActive?: boolean;
  eventTimestamp: number;
  completedLLMEndTimes: number[];
}): boolean {
  if (!isActive && completedLLMEndTimes.length > 0) return false;
  return !completedLLMEndTimes.some((endTime) => eventTimestamp <= endTime);
}

/**
 * Pull `metadata.args` out of a live event's metadata blob.
 * `args` is the canonical key for tool input on `tool_start` events.
 *
 * Metadata arrives in two shapes depending on path:
 *   - REST `/api/runs/detail/:id` → DB column is `JSON.stringify`'d (string)
 *   - WebSocket `broadcast("live", …)` → raw `req.body.metadata` object
 * Both must produce the same preview. Bad/missing JSON yields `undefined`
 * so the caller renders the pill without args.
 */
export function extractLiveToolArgs(metadata: unknown): unknown {
  if (metadata == null) return undefined;
  let parsed: unknown;
  try {
    parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
  } catch {
    return undefined;
  }
  if (parsed && typeof parsed === "object" && "args" in parsed) {
    return parsed.args;
  }
  return undefined;
}
