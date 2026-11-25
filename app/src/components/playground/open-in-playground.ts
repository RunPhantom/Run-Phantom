import { SquareTerminal } from "lucide-react";
import type { SpanAction } from "../run-detail/span-actions";

export function playgroundPathForSpan(spanId: string, runId?: string | null): string {
  const params = new URLSearchParams({ span: spanId });
  if (runId) params.set("run", runId);
  return `/playground?${params}`;
}

export const openInPlaygroundAction: SpanAction = {
  id: "playground:open-span",
  label: "Open in Playground",
  icon: SquareTerminal,
  order: 10,
  when: ({ span }) => !!span.span_type?.includes("LLM"),
  run: ({ span, runId, navigate }) => navigate(playgroundPathForSpan(span.id, runId)),
};
