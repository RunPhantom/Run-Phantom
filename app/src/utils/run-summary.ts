import type { Span } from "./types";

type SummarySpan = Pick<Span, "name" | "span_type" | "status" | "model">;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const list = (names: string[]) => names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => !!value))];

/**
 * A deterministic, local summary of a run for the Saved list. It never calls
 * a provider: it reads the first user message and counts tools, failures and
 * model calls from the captured spans.
 */
export function localRunSummary({ name, userInput, spans }: { name: string; userInput: string | null; spans: readonly SummarySpan[] }): string {
  const question = userInput?.trim() ? clip(userInput, 90) : "";
  const parts: string[] = [question ? `Asked “${question}”${/[.?!…]$/.test(question) ? "" : "."}` : `${clip(name, 60)} run.`];
  const tools = spans.filter(span => span.span_type === "TOOL_CALL");
  const failed = unique(spans.filter(span => span.status === "ERROR" && span.span_type !== "AGENT_ROOT").map(span => span.name));
  const models = unique(spans.filter(span => span.span_type?.includes("LLM")).map(span => span.model));
  const llmCalls = spans.filter(span => span.span_type?.includes("LLM")).length;
  if (tools.length) parts.push(`Used ${tools.length} tool ${tools.length === 1 ? "call" : "calls"} (${list(unique(tools.map(span => span.name)))}).`);
  if (llmCalls) parts.push(`${llmCalls} model ${llmCalls === 1 ? "call" : "calls"}${models.length ? ` with ${list(models)}` : ""}.`);
  if (failed.length) parts.push(`Failed: ${list(failed)}.`);
  else if (spans.some(span => span.status === "ERROR")) parts.push("The run reported an error.");
  return parts.join(" ");
}
