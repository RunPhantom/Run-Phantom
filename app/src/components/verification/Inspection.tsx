import { Button } from "../ui/button";
import type { CommandResult } from "../../api/verification";

function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span>null</span>;
  if (typeof value !== "object") return <span className="break-words">{String(value).slice(0, 500)}</span>;
  const entries = Object.entries(value);
  if (depth >= 3) return <span>{Array.isArray(value) ? `${entries.length} items` : `${entries.length} properties`}</span>;
  if (!entries.length) return <span>{Array.isArray(value) ? "Empty list" : "Empty object"}</span>;
  return <dl className="space-y-1.5">{entries.slice(0, 10).map(([key, item]) => <div key={key} className="grid grid-cols-[minmax(64px,1fr)_minmax(0,2fr)] gap-3"><dt className="break-words text-[color:var(--rp-ink-muted)]">{key}</dt><dd><Value value={item} depth={depth + 1} /></dd></div>)}{entries.length > 10 && <div className="text-[color:var(--rp-ink-muted)]">{entries.length - 10} more entries</div>}</dl>;
}

export function Inspection({ response, onSelect }: { response: CommandResult; onSelect: (selector: string) => void }) {
  const value = response.result;
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const elements = Array.isArray(data.elements) ? data.elements : null;
  return <section aria-label="App inspection" className="space-y-3 rounded-md border border-[color:var(--rp-border)] p-3 text-xs">
    <h3 className="font-semibold">App inspection</h3>
    {response.truncated && <p className="text-[color:var(--rp-warning)]">Partial snapshot: some content was omitted or redacted.</p>}
    {elements ? <><p className="text-[color:var(--rp-ink-soft)]">{String(data.count ?? elements.length)} elements. Showing the first {Math.min(20, elements.length)}.</p><ul className="max-h-72 space-y-3 overflow-auto">{elements.slice(0, 20).map((item: unknown, index: number) => {
      if (!item || typeof item !== "object") return null;
      const element = item as Record<string, unknown>;
      const id = typeof element.id === "string" ? element.id : "";
      return <li key={index} className="flex items-start justify-between gap-3"><span className="min-w-0 break-words"><span className="font-medium">{String(element.tag ?? "element")}{id && ` #${id}`}</span>{element.label ? ` — ${String(element.label)}` : ""}{element.disabled ? " (disabled)" : ""}</span>{id && <Button type="button" size="sm" variant="ghost" onClick={() => onSelect(`#${CSS.escape(id)}`)} aria-label={`Use selector for ${id}`}>Use selector</Button>}</li>;
    })}</ul></> : <Value value={data} />}
  </section>;
}
