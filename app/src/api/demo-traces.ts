/** Replays the bundled sample traces into the workspace and returns the new run ids, in replay order. */
export async function replayDemoTraces(): Promise<string[]> {
  const response = await fetch("/api/demo-traces/replay", { method: "POST" });
  const body = await response.json().catch(() => null) as { runIds?: unknown; error?: unknown } | null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `Could not load sample runs (${response.status}).`);
  return Array.isArray(body?.runIds) ? body.runIds.filter((id): id is string => typeof id === "string") : [];
}
