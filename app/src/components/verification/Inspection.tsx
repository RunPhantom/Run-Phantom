import { Button } from "../ui/button";
import { Eyebrow } from "../ui/typography";
import type { CommandResult } from "../../api/verification";

function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span>null</span>;
  if (typeof value !== "object") return <span className="break-words">{String(value).slice(0, 500)}</span>;
  const entries = Object.entries(value);
  if (depth >= 3) return <span>{Array.isArray(value) ? `${entries.length} items` : `${entries.length} properties`}</span>;
  if (!entries.length) return <span>{Array.isArray(value) ? "Empty list" : "Empty object"}</span>;
  return <dl className="space-y-1.5">{entries.slice(0, 10).map(([key, item]) => <div key={key} className="grid grid-cols-[minmax(64px,1fr)_minmax(0,2fr)] gap-3"><dt className="rp-meta break-words">{key}</dt><dd><Value value={item} depth={depth + 1} /></dd></div>)}{entries.length > 10 && <div className="text-rp-ink-muted">{entries.length - 10} more entries</div>}</dl>;
}

export function Inspection({ response, onSelect }: { response: CommandResult; onSelect: (selector: string) => void }) {
  const value = response.result;
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const elements = Array.isArray(data.elements) ? data.elements : null;
  return <section aria-label="App inspection" className="rp-fade-rise min-w-0 space-y-3 rounded-md border border-rp-line bg-rp-canvas-blue p-4 text-[13px]">
    <Eyebrow as="h3" marker>App inspection</Eyebrow>
    {response.truncated && <p className="rounded-sm border border-rp-warning-border bg-rp-warning-soft px-3 py-2 text-[12px] text-rp-warning">Partial snapshot: some content was omitted or redacted.</p>}
    {elements ? <><p className="text-rp-ink-muted">{String(data.count ?? elements.length)} elements. Showing the first {Math.min(20, elements.length)}.</p><ul className="max-h-72 divide-y divide-rp-line-muted overflow-auto rounded-sm border border-rp-line-muted bg-white">{elements.slice(0, 20).map((item: unknown, index: number) => {
      if (!item || typeof item !== "object") return null;
      const element = item as Record<string, unknown>;
      const id = typeof element.id === "string" ? element.id : "";
      return <li key={index} className="flex min-h-10 items-center justify-between gap-3 px-3 py-1.5 transition-colors duration-250 ease-standard hover:bg-rp-row-hover"><span className="min-w-0 break-words"><span className="font-mono text-[12px] font-medium text-rp-ink">{String(element.tag ?? "element")}{id && ` #${id}`}</span>{element.label ? ` — ${String(element.label)}` : ""}{element.disabled ? " (disabled)" : ""}</span>{id && <Button type="button" size="sm" variant="ghost" onClick={() => onSelect(`#${CSS.escape(id)}`)} aria-label={`Use selector for ${id}`}>Use selector</Button>}</li>;
    })}</ul></> : <Value value={data} />}
  </section>;
}
