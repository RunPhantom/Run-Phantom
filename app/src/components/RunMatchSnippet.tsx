import type { RunSearchMatch } from "../../../src/search-protocol";
import { highlightedText } from "./SearchSpanHits";

function matchLabel(match: RunSearchMatch): string {
  const step = match.span_name ?? "a step";
  switch (match.field) {
    case "error": return `Error in ${step}`;
    case "failed_span": return `Failed step: ${step}`;
    case "span_name": return "Step name";
    case "model": return "Model";
    case "provider": return "Provider";
    case "output": return `Output of ${step}`;
    case "input": return `Input to ${step}`;
    case "run": return "Run details";
    case "metadata": return "Run metadata";
  }
}

/** Why a search result matched: the best match from the API, with its highlight ranges. */
export function RunMatchSnippet({ match, matchedSpans }: { match: RunSearchMatch; matchedSpans?: number | null }) {
  const failure = match.field === "error" || match.field === "failed_span";
  const more = matchedSpans && matchedSpans > 1 ? ` · ${matchedSpans} matching steps` : "";
  return (
    <span data-run-match={match.field} className="mt-1.5 block min-w-0 border-l-2 pl-2 text-[11px] leading-4" style={{ borderColor: failure ? "var(--rp-danger)" : "var(--rp-line)" }}>
      <span className={failure ? "block truncate font-medium text-rp-danger" : "block truncate font-medium text-rp-ink-soft"}>{matchLabel(match)}{more}</span>
      {match.snippet.state === "available" && match.snippet.text
        ? <span className="mt-0.5 line-clamp-2 break-words text-rp-ink">{highlightedText(match.snippet)}</span>
        : null}
    </span>
  );
}
