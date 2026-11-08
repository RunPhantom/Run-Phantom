import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HelpCircle } from "lucide-react";
import { ago } from "../utils/helpers";
import { Dots } from "./Icons";
import { ToolCallPill } from "./ToolCallPill";
import { Markdown } from "./Markdown";
import type { Run } from "../utils/types";
import { buildConvoEvents } from "./convo-events";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { isRunDeleting, useConversationDetail } from "../hooks/use-runs";

function ConversationHeader({ runCount }: { runCount: number }) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="rp-eyebrow"><span aria-hidden="true" className="rp-eyebrow-marker" />conversation</span>
      <span className="group relative inline-flex items-center">
        <HelpCircle aria-hidden="true" size={13} className="cursor-help text-rp-ink-muted" />
        <div className="absolute left-0 top-full z-50 mt-2 hidden group-hover:block">
          <div className="rp-pop whitespace-nowrap rounded-md border border-rp-line bg-rp-surface px-3 py-2 text-[12px] leading-relaxed text-rp-ink shadow-e3">
            Conversation groups separate runs that share the same conversation ID.
          </div>
        </div>
      </span>
      <span aria-hidden="true" className="text-rp-ink-faint">&middot;</span>
      <span className="rp-meta">{runCount} run{runCount !== 1 ? "s" : ""}</span>
    </div>
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end px-4 pb-1 pt-5">
      <div className="max-w-[65%] rounded-md border border-rp-line bg-rp-surface px-3.5 py-2.5">
        <div className="relative">
          <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-rp-ink">
            {content}
          </pre>
        </div>
      </div>
    </div>
  );
}

function TurnDivider({ index, run, onOpen, onHover }: { index: number; run: Run; onOpen: () => void; onHover: (hovering: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 px-4 pb-2 pt-6">
      <div className="h-px flex-1 bg-rp-line" />
      <span className="rp-eyebrow text-rp-ink">
        Run {index + 1}
      </span>
      <span className="rp-meta">{ago(run.started_at)}</span>
      <button
        className="h-7 rounded-control border border-rp-line bg-rp-surface px-2 text-[12px] font-medium text-rp-blue transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash"
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onClick={onOpen}
      >
        open &rarr;
      </button>
      <div className="h-px flex-1 bg-rp-line" />
    </div>
  );
}

export function ConvoDetail({ convoId, onOpenTurn }: { convoId: string; onOpenTurn?: (runId: string) => void }) {
  const queryClient = useQueryClient();
  const { turns, runIds, isLoading, isError } = useConversationDetail(convoId);
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useRunPhantomEvent("spans", () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation-runs", convoId] });
    for (const runId of runIds) {
      if (isRunDeleting(runId)) continue;
      void queryClient.invalidateQueries({ queryKey: ["run-detail", runId] });
    }
  });
  useRunPhantomEvent("live", () => {
    for (const runId of runIds) {
      if (isRunDeleting(runId)) continue;
      void queryClient.invalidateQueries({ queryKey: ["run-detail", runId] });
    }
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-scroll when the user is already near the bottom, so a live turn
    // update (WS-triggered) doesn't yank them back down while reading history.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const events = useMemo(() => buildConvoEvents(turns), [turns]);

  if (isLoading) return <div role="status" className="flex h-full items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-rp-ink-muted">Loading conversation <Dots /></div>;
  if (isError) return <div role="alert" className="mx-4 my-6 rounded-lg border border-dashed border-rp-danger-border bg-rp-danger-soft px-6 py-8 text-center text-[13px] text-rp-danger">Could not load conversation</div>;
  if (turns.length === 0) return <div className="mx-4 my-6 rounded-lg border border-dashed border-rp-line-dashed bg-rp-surface px-6 py-8 text-center text-[13px] text-rp-ink-muted">No runs found</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-shrink-0 items-center border-b border-rp-line px-4 py-3">
        <ConversationHeader runCount={turns.length} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto sb pb-24">
        {events.map((evt, i) => {
          const turnIdx = evt.turnIndex;
          const dimmed = hoveredTurn !== null && turnIdx !== hoveredTurn;

          if (evt.type === "turn_start") {
            return (
              <div key={`td${i}`} style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 250ms cubic-bezier(.25,.1,.25,1)" }}>
                <TurnDivider index={evt.turnIndex} run={evt.run}
                  onOpen={() => onOpenTurn?.(evt.run.id)}
                  onHover={(h) => setHoveredTurn(h ? evt.turnIndex : null)} />
              </div>
            );
          }

          if (evt.type === "user_msg") {
            return (
              <div key={`um${i}`} style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 250ms cubic-bezier(.25,.1,.25,1)" }}>
                <UserMessage content={evt.content} />
              </div>
            );
          }

          if (evt.type === "tool_group") {
            return (
              <div key={`tg${i}`} className="flex flex-wrap gap-1.5 px-4 py-1" style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 250ms cubic-bezier(.25,.1,.25,1)" }}>
                {evt.spans.map(s => (
                  <ToolCallPill key={s.id} span={s} />
                ))}
              </div>
            );
          }

          if (evt.type === "llm_out") {
            return (
              <div key={`lo${i}`} className="max-w-[85%] px-4 py-2" style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 250ms cubic-bezier(.25,.1,.25,1)" }}>
                <div className="text-message leading-relaxed text-rp-ink">
                  <Markdown>{evt.content}</Markdown>
                </div>
              </div>
            );
          }

          if (evt.type === "active") {
            return (
              <div key={`act${i}`} className="px-4 py-2 text-[11px] font-mono" style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 250ms cubic-bezier(.25,.1,.25,1)", color: "var(--rp-ink-muted)" }}>
                running <Dots />
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
