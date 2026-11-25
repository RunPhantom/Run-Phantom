import { useEffect, useId, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ListTree, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { commandDetail, commandStatus, useCommands, type CommandContext, type PaletteCommand, type PaletteStatus } from "./commands";
import { buildSections } from "./palette-model";
import { closeOverlay, restoreOverlayFocus, useShellOverlay } from "./overlays";
import { formatKeys, isMacPlatform } from "./keyboard";

function Highlighted({ text, indices }: { text: string; indices: number[] }): ReactNode {
  if (indices.length === 0) return text;
  // fuzzyScore returns UTF-16 indices (indexOf), so iterate code units, not code points.
  const marks = new Set(indices);
  const parts: ReactNode[] = [];
  let buffer = "";
  let marked = false;
  const flush = (key: number) => {
    if (!buffer) return;
    parts.push(marked ? <mark key={key} className="bg-transparent font-semibold text-rp-ink">{buffer}</mark> : <span key={key}>{buffer}</span>);
    buffer = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const isMark = marks.has(index);
    if (isMark !== marked) { flush(index); marked = isMark; }
    buffer += text[index];
  }
  flush(text.length);
  return parts;
}

const DETAIL_REFRESH_MS = 30_000;
/** /api/runs returns up to 5000 metrics-enriched rows, so a palette opened again within this window reuses the list. */
const RECENT_RUNS_FRESH_MS = 10_000;

const STATUS_DOTS: Record<PaletteStatus["tone"], string> = {
  ok: "bg-rp-ink-faint",
  warning: "bg-rp-mark-warning",
  error: "bg-rp-mark-danger",
  live: "bg-rp-mark-success pulse-dot",
  cancelled: "border border-rp-ink-subtle bg-transparent",
  unknown: "border border-rp-ink-faint bg-transparent",
};

/** Free-text search hands off to the Search page, which runs the query server-side. */
function searchCommands(query: string): PaletteCommand[] {
  const text = query.trim();
  if (!text) return [];
  const quoted = text.length > 48 ? `${text.slice(0, 47)}…` : text;
  return [
    { id: "search:runs", group: "Search", label: `Search runs for “${quoted}”`, keywords: [text], icon: Search, order: 0,
      run: ({ navigate }) => navigate(`/search?${new URLSearchParams({ q: text })}`) },
    { id: "search:steps", group: "Search", label: `Search steps for “${quoted}”`, keywords: [text], icon: ListTree, order: 1,
      run: ({ navigate }) => navigate(`/search?${new URLSearchParams({ q: text, resource: "span-hits" })}`) },
  ];
}

export function CommandPalette() {
  const open = useShellOverlay() === "palette";
  return (
    <DialogPrimitive.Root open={open} onOpenChange={next => { if (!next) closeOverlay(); }}>
      {open && <PaletteBody />}
    </DialogPrimitive.Root>
  );
}

function PaletteBody() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const baseId = useId();
  const mac = useMemo(isMacPlatform, []);
  const [, setTick] = useState(0);

  useEffect(() => {
    const updatedAt = queryClient.getQueryState(["runs"])?.dataUpdatedAt ?? 0;
    if (Date.now() - updatedAt > RECENT_RUNS_FRESH_MS) void queryClient.invalidateQueries({ queryKey: ["runs"], exact: true });
    const timer = window.setInterval(() => setTick(tick => tick + 1), DETAIL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [queryClient]);

  const sections = buildSections([...commands, ...searchCommands(query)], query);
  const flat = sections.flatMap(section => section.rows);
  const matchCount = flat.filter(row => row.command.group !== "Search").length;
  const nothingMatches = matchCount === 0;
  const active = flat[Math.min(activeIndex, flat.length - 1)];
  const optionId = (command: PaletteCommand) => `${baseId}-option-${command.id}`;

  useEffect(() => { setActiveIndex(0); }, [query]);
  useEffect(() => {
    if (!active) return;
    document.getElementById(optionId(active.command))?.scrollIntoView({ block: "nearest" });
  }, [active?.command.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const context: CommandContext = {
    navigate,
    close: closeOverlay,
    announce: message => setAnnouncement(message),
  };

  async function runCommand(command: PaletteCommand) {
    if (!command.keepOpen) closeOverlay();
    try {
      await command.run(context);
    } catch (error) {
      setAnnouncement(error instanceof Error && error.message ? error.message : `${command.label} failed.`);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    const count = flat.length;
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      if (count) setActiveIndex(index => (Math.min(index, count - 1) + 1) % count);
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      if (count) setActiveIndex(index => (Math.min(index, count - 1) - 1 + count) % count);
    } else if (event.key === "Home" && count) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End" && count) {
      event.preventDefault();
      setActiveIndex(count - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active && !event.nativeEvent.isComposing) void runCommand(active.command);
    } else if (event.key.toLowerCase() === "k" && (mac ? event.metaKey : event.ctrlKey)) {
      event.preventDefault();
      closeOverlay();
    }
  }

  let rowIndex = -1;
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[color:var(--rp-scrim-soft)] data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:!animate-none" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onCloseAutoFocus={restoreOverlayFocus}
        data-command-palette
        className="fixed inset-x-0 top-[12vh] z-50 mx-auto flex max-h-[min(640px,76vh)] w-[min(640px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-rp-line bg-rp-surface shadow-e4 animate-fade-rise motion-reduce:animate-none sm:top-[18vh]"
      >
        <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
        <div className="flex items-center gap-3 border-b border-rp-line px-4">
          <Search aria-hidden="true" className="size-4 shrink-0 text-rp-ink-subtle" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-listbox`}
            aria-activedescendant={active ? optionId(active.command) : undefined}
            aria-autocomplete="list"
            aria-label="Search runs, steps, commands"
            placeholder="Search runs, steps, commands"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-rp-ink outline-none placeholder:text-rp-ink-subtle focus-visible:!outline-none"
          />
          <kbd className="rp-kbd hidden sm:inline-flex" aria-hidden="true">Esc</kbd>
        </div>
        {nothingMatches && (
          <p className="px-5 pb-1 pt-4 text-[13px] text-rp-ink-muted">
            {query.trim() ? <>No pages, runs or commands match “{query.trim()}”.</> : "No commands available."}
          </p>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {query.trim() ? (nothingMatches ? "No matches" : `${matchCount} ${matchCount === 1 ? "result" : "results"}`) : ""}
        </p>
        <div id={`${baseId}-listbox`} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          {sections.map(section => {
            const headingId = `${baseId}-group-${section.group.replace(/\W+/g, "-")}`;
            return (
              <div key={section.group} role="group" aria-labelledby={headingId} className="pb-1">
                <div id={headingId} role="presentation" className="rp-eyebrow px-3 pb-1 pt-2 text-rp-ink-subtle">{section.group}</div>
                {section.rows.map(row => {
                  rowIndex += 1;
                  const index = rowIndex;
                  const { command } = row;
                  const selected = active?.command.id === command.id;
                  const Icon = command.icon;
                  const status = commandStatus(command);
                  const detail = commandDetail(command);
                  return (
                    <div
                      key={command.id}
                      id={optionId(command)}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => { if (activeIndex !== index) setActiveIndex(index); }}
                      onClick={() => void runCommand(command)}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-1.5 text-[13px] text-rp-ink [@media(pointer:fine)]:min-h-9",
                        selected ? "bg-rp-wash shadow-[inset_2px_0_0_var(--rp-accent)]" : "",
                      )}
                    >
                      {status ? (
                        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATUS_DOTS[status.tone])} />
                      ) : Icon ? (
                        <Icon aria-hidden="true" className="size-4 shrink-0 text-rp-ink-subtle" />
                      ) : (
                        <span aria-hidden="true" className="size-4 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        <Highlighted text={command.label} indices={row.indices} />
                        {status && <span className="sr-only">, {status.label}</span>}
                      </span>
                      {detail && <span className="max-w-[45%] shrink-0 truncate font-mono text-[12px] text-rp-ink-subtle">{detail}</span>}
                      {command.shortcut && <kbd aria-hidden="true" className="rp-kbd shrink-0">{formatKeys(command.shortcut, mac)}</kbd>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-rp-line px-4 py-2 text-[12px] text-rp-ink-subtle">
          <p role="status" aria-live="polite" className="min-w-0 truncate text-rp-ink">{announcement}</p>
          <p aria-hidden="true" className="hidden shrink-0 items-center gap-1.5 sm:flex">
            <kbd className="rp-kbd">↑</kbd><kbd className="rp-kbd">↓</kbd> move
            <kbd className="rp-kbd ml-2">↵</kbd> run
            <kbd className="rp-kbd ml-2">Esc</kbd> close
          </p>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
