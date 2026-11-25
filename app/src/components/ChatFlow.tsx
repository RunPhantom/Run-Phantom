import { CaptureVisibilityDetails } from "./CaptureVisibilityDetails";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { compactTokens, displayPayload, fmt, MAX_INLINE_PAYLOAD, plural, trunc, tryJson } from "../utils/helpers";
import type { LiveEvent, Span, SubAgent } from "../utils/types";
import { FlameTimeline } from "./FlameTimeline";
import { AlertCircle, Check, Chevron, Dots, Spinner } from "./Icons";
import { Markdown } from "./Markdown";
import { MessageImages, MessageList } from "./MessageList";
import { ToolCallPill } from "./ToolCallPill";
import { useSmoothText } from "../hooks/use-smooth-text";
import { canEditReplayMessage } from "../utils/messageParsing";
import { spanCost } from "../../../src/pricing/span-cost";
import { fmtCost } from "../utils/costs";
import { countedLlmSpans } from "./run-detail/trace-model";
import { buildChatItems, subAgentsWithin, type ChatItem } from "./chat-items";

function PreviousMessages({ messages }: { messages: { role: string; content: string }[] }) {
  const [expanded, setExpanded] = useState(false);
  const counts = ["assistant", "user", "tool"]
    .map(r => { const n = messages.filter(m => m.role === r).length; return n > 0 ? `${n} ${r}` : null; })
    .filter(Boolean).join(", ");

  return (
    <div>
      <div className="flex items-center gap-3 py-3">
        <div className="h-px flex-1 bg-rp-line" />
        <button
          className="flex flex-col items-center whitespace-pre rounded-control border border-rp-line bg-rp-surface px-4 py-1.5 font-mono text-[11px] leading-tight text-rp-ink transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            "hide"
          ) : (
            <>
              <span className="font-sans text-[12px] font-medium normal-case leading-snug text-rp-ink">
                previous messages
              </span>
              <span className="mt-0.5 text-[10px] font-normal text-rp-ink-muted">
                {counts}
              </span>
            </>
          )}
        </button>
        <div className="h-px flex-1 bg-rp-line" />
      </div>
      {expanded && <div className="mt-1"><MessageList messages={messages} /></div>}
    </div>
  );
}

type AgentDisclosure = {
  expanded: ReadonlySet<string>;
  toggle: (rootSpanId: string) => void;
  focus: { rootSpanId: string; request: number } | null;
  md: boolean;
};
const AgentDisclosureContext = createContext<AgentDisclosure | null>(null);

function useAgentUsage(agent: SubAgent, spans: Span[]) {
  return useMemo(() => {
    const members = new Set(agent.span_ids);
    const calls = countedLlmSpans(spans.filter(s => members.has(s.id) && s.id !== agent.root_span_id));
    let known = 0, unknown = 0, estimated = false;
    for (const call of calls) {
      const cost = spanCost(call);
      if (cost.usd == null) unknown++;
      else { known += cost.usd; if (cost.source === "list-price") estimated = true; }
    }
    const costText = calls.length === 0 || unknown === calls.length ? null
      : `${fmtCost(known)}${unknown ? "+" : ""}${estimated ? " est." : ""}`;
    return { costText };
  }, [spans, agent.root_span_id, agent.span_ids]);
}

/**
 * A sub-agent as a collapsible card in its parent's transcript. Expanded, it
 * shows the agent's own prompt, replies, tool calls and the cards of the
 * agents it delegated to, recursively.
 */
export function SubAgentBlock({ agent, spans, subAgents, onDiveIn }: { agent: SubAgent; spans: Span[]; subAgents: readonly SubAgent[]; onDiveIn?: (id: string) => void }) {
  const disclosure = useContext(AgentDisclosureContext);
  const [localOpen, setLocalOpen] = useState(false);
  const open = disclosure ? disclosure.expanded.has(agent.root_span_id) : localOpen;
  const headerRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const { costText } = useAgentUsage(agent, spans);
  const tokens = agent.total_input_tokens + agent.total_output_tokens;
  const failed = agent.status === "ERROR";
  const focusRequest = disclosure?.focus?.rootSpanId === agent.root_span_id ? disclosure.focus.request : 0;

  // The Trajectory asks for a span inside this agent: the provider has
  // already expanded this card and its ancestors, so the header is mounted.
  useEffect(() => {
    if (!focusRequest || !headerRef.current) return;
    headerRef.current.scrollIntoView({ behavior: "instant", block: "center" });
    headerRef.current.focus({ preventScroll: true });
  }, [focusRequest]);

  return (
    <section
      data-sub-agent={agent.root_span_id}
      className={cn("min-w-0 basis-full rounded-md border bg-rp-surface", failed ? "border-rp-danger-border" : "border-rp-line")}
    >
      <div className="flex min-w-0 items-center gap-1 p-1">
        <button
          ref={headerRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-sm px-2 py-1 text-left text-xs transition-colors duration-250 ease-standard hover:bg-rp-row-hover"
          onClick={() => disclosure ? disclosure.toggle(agent.root_span_id) : setLocalOpen(!localOpen)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-rp-ink-muted"><Chevron open={open} size={10} /></span>
            <span className="shrink-0 rounded-sm bg-rp-wash px-1 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.08em] text-rp-blue">agent</span>
            <span className="min-w-0 truncate font-medium text-rp-ink">{agent.name}</span>
            {failed && <span className="inline-flex shrink-0 items-center gap-1 font-medium text-rp-danger"><AlertCircle /> failed</span>}
          </span>
          <span className="rp-num min-w-0 text-[11px] text-rp-ink-muted">
            {plural(agent.tool_count, "tool")} &middot; {fmt(agent.duration_ms)}{tokens > 0 && <> &middot; {compactTokens(tokens)} tok</>}{costText && <> &middot; {costText}</>}
          </span>
        </button>
        {onDiveIn && (
          <button
            type="button"
            className="min-h-9 shrink-0 whitespace-nowrap rounded-control px-2.5 text-[12px] font-medium text-rp-blue transition-colors duration-250 ease-standard hover:bg-rp-wash"
            onClick={() => onDiveIn(agent.root_span_id)}
          >
            Open Sub-Agent &rarr;
          </button>
        )}
      </div>
      {open && (
        <div id={bodyId} role="region" aria-label={`${agent.name} sub-agent details`} className="border-t border-rp-line-muted">
          <SubAgentBody agent={agent} spans={spans} subAgents={subAgents} onDiveIn={onDiveIn} costText={costText} md={disclosure?.md ?? true} />
        </div>
      )}
    </section>
  );
}

function SubAgentBody({ agent, spans, subAgents, onDiveIn, costText, md }: { agent: SubAgent; spans: Span[]; subAgents: readonly SubAgent[]; onDiveIn?: (id: string) => void; costText: string | null; md: boolean }) {
  const items = useMemo(() => {
    const members = new Set(agent.span_ids);
    const own = spans.filter(s => members.has(s.id) && s.id !== agent.root_span_id);
    const root = spans.find(s => s.id === agent.root_span_id);
    return buildChatItems({ spans: own, liveEvents: [], subAgents: subAgentsWithin(agent, subAgents), fallbackInput: root?.input_payload ?? null });
  }, [agent, spans, subAgents]);

  return (
    <div className="space-y-1.5 pb-2 pt-1">
      {items.length === 0
        ? <p className="px-4 py-2 text-[13px] text-rp-ink-muted">No messages or tool calls were recorded for this agent.</p>
        : <ChatItemList items={items} spans={spans} subAgents={subAgents} onDiveIn={onDiveIn} md={md} asSubAgent />}
      <p className="rp-meta break-words px-4 pt-1 text-[10px]">
        {agent.model && <>{agent.model} &middot; </>}
        {plural(agent.llm_count, "LLM call")} &middot; {plural(agent.tool_count, "tool")} &middot; {fmt(agent.duration_ms)}
        {agent.total_input_tokens > 0 && <> &middot; {agent.total_input_tokens.toLocaleString()} in</>}
        {agent.total_output_tokens > 0 && <> &middot; {agent.total_output_tokens.toLocaleString()} out</>}
        {costText && <> &middot; {costText}</>}
      </p>
    </div>
  );
}

/** The task a parent agent handed to a sub-agent. It is not something the user typed. */
function AgentPrompt({ content }: { content: string }) {
  const capped = content.length > MAX_INLINE_PAYLOAD ? `${content.slice(0, MAX_INLINE_PAYLOAD)}…` : content;
  const long = capped.length > 280 || capped.split("\n").length > 4;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="px-4 pb-1 pt-2">
      <div className="max-w-[85%] rounded-md border border-rp-line bg-rp-canvas-blue px-3 py-2">
        <div className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted">Prompt from parent agent</div>
        <pre className={cn("whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-rp-ink", long && !expanded && "line-clamp-4")}>{capped}</pre>
        {long && (
          <button type="button" aria-expanded={expanded} className="-ml-1.5 mt-0.5 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink"
            onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show all"}</button>
        )}
      </div>
    </div>
  );
}

function UserBubble({ content, collapsible }: { content: string; collapsible?: boolean }) {
  // Cap inline render: a multi-MB user payload would otherwise mount as one
  // giant text node. maxHeight only clips visually, not the DOM cost.
  const capped = content.length > MAX_INLINE_PAYLOAD
    ? content.slice(0, MAX_INLINE_PAYLOAD) +
      `\n\n… [truncated — ${(content.length - MAX_INLINE_PAYLOAD).toLocaleString()} more characters omitted for performance]`
    : content;
  const lines = capped.split("\n").length;
  const canCollapse = collapsible && (capped.length > 120 || lines > 3);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className="rounded-md border border-rp-line bg-rp-surface px-3.5 py-2.5"
    >
      <pre
        className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-rp-ink"
        style={{
          ...(collapsed ? { maxHeight: 22, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const } : {}),
        }}
      >
        {capped}
      </pre>
      {canCollapse && (
        <button className="-ml-1.5 mt-0.5 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink"
          onClick={() => setCollapsed(!collapsed)}>{collapsed ? "expand" : "collapse"}</button>
      )}
    </div>
  );
}

function UserMessage({ content, parts, images, onEdit }: { content: string; parts?: string[]; images?: string[]; onEdit?: (content: string) => void }) {
  const segments = parts && parts.length > 1 ? parts : content ? [content] : [];
  const multiPart = segments.length > 1;
  const hasImages = !!images?.length;
  const editAction = onEdit && canEditReplayMessage({ images }) ? onEdit : undefined;

  return (
    <div className="group/usermsg flex justify-end px-4 pt-6 pb-2">
      <div
        className="relative min-w-0"
        style={{
          width: multiPart || hasImages ? "min(100%, max(50%, 400px))" : undefined,
          maxWidth: "min(100%, max(50%, 400px))",
        }}
      >
        <div className="space-y-1.5">
          {multiPart
            ? segments.map((seg, i) => <UserBubble key={i} content={seg} collapsible />)
            : segments.length > 0 && <UserBubble content={segments[0]} />}
          {hasImages && <MessageImages images={images!} />}
        </div>
        {editAction && (
          <button
            type="button"
            aria-label="Edit message and replay run"
            className="absolute -bottom-2 -right-2 flex min-h-7 min-w-7 items-center justify-center rounded-control border border-rp-line bg-rp-surface text-rp-ink-muted opacity-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:opacity-100 transition-[opacity,background-color,color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash hover:text-rp-blue focus-visible:opacity-100 group-hover/usermsg:opacity-100"
            title="Edit & replay"
            onClick={() => editAction(content)}
          >
            <Pencil aria-hidden="true" className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function LLMOutput({ content, md }: { content: string; md: boolean }) {
  // Cap what is rendered inline: a multi-MB assistant payload would otherwise
  // mount tens of MB of DOM (and run remark/Shiki over all of it). Length-only
  // cap, so we never reformat JSON-shaped output.
  const capped = content.length > MAX_INLINE_PAYLOAD
    ? content.slice(0, MAX_INLINE_PAYLOAD) +
      `\n\n… [truncated — ${(content.length - MAX_INLINE_PAYLOAD).toLocaleString()} more characters omitted for performance]`
    : content;
  return (
    <div>
      <div className="max-w-[85%]">
        {md ? (
          <div className="text-message leading-relaxed text-rp-ink">
            <Markdown>{capped}</Markdown>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-message leading-relaxed text-rp-ink">
            {capped}
          </pre>
        )}
      </div>
    </div>
  );
}

function RenderModeToggle({ md, onChange }: { md: boolean; onChange: (md: boolean) => void }) {
  const option = (selected: boolean) => cn(
    "h-6 rounded-sm px-2 text-[11px] font-medium transition-[background-color,color] duration-250 ease-standard",
    selected ? "bg-rp-wash text-rp-blue" : "text-rp-ink-muted hover:text-rp-ink",
  );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-control border border-rp-line bg-rp-surface p-0.5">
      <button
        type="button"
        aria-pressed={md}
        className={option(md)}
        onClick={() => onChange(true)}
      >
        Markdown
      </button>
      <button
        type="button"
        aria-pressed={!md}
        className={option(!md)}
        onClick={() => onChange(false)}
      >
        Raw
      </button>
    </div>
  );
}

function ActiveSpinner({ isActive, lastUpdatedAt, liveEvents, spans }: {
  isActive?: boolean; lastUpdatedAt?: number; liveEvents: LiveEvent[]; spans: Span[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [isActive]);

  if (!isActive || !lastUpdatedAt) return null;

  const hasFinished = spans.some(s => {
    if (!s.attributes) return false;
    try {
      const attrs = JSON.parse(s.attributes);
      const reason = attrs["ai.response.finishReason"];
      return reason && reason !== "unknown";
    } catch { return false; }
  });
  if (hasFinished) return null;

  const elapsed = now - lastUpdatedAt;
  if (elapsed < 1000 || elapsed > 10000) return null;

  const lastLive = liveEvents.length > 0 ? liveEvents[liveEvents.length - 1].timestamp : 0;
  if (now - lastLive < 500) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="flex gap-1">
        {[0, 1, 2].map(i => (
          <div key={i} className="size-1.5 rounded-full"
            style={{ background: "var(--rp-ink-muted)", animation: "bounce-dot 1.4s infinite ease-in-out", animationDelay: `${i * 0.16}s` }} />
        ))}
      </div>
    </div>
  );
}

function SmoothTextDelta({ content, enabled, as: Tag = "pre", className, style }: {
  content: string; enabled: boolean; as?: "pre" | "span" | "div"; className?: string; style?: React.CSSProperties;
}) {
  const displayed = useSmoothText(content, enabled);
  return (
    <Tag className={className ?? "font-sans whitespace-pre-wrap text-message"} style={style ?? { color: "var(--rp-ink)" }}>{displayed}</Tag>
  );
}

function LLMErrorBanner({ content }: { content: string }) {
  const [hovered, setHovered] = useState(false);
  const formatted = tryJson(content);
  const detail = displayPayload(content);

  return (
    <div
      tabIndex={0}
      aria-label="LLM error. Focus or hover for details."
      className="relative inline-flex items-center gap-1.5 cursor-default"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <div className="flex items-center gap-2 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-1.5">
        <AlertCircle />
        <span className="text-[12px] font-medium text-rp-danger">LLM Error</span>
        <span className="max-w-[300px] truncate font-mono text-[11px] text-rp-danger">
          {trunc(formatted, 80)}
        </span>
      </div>
      {hovered && (
        <div className="rp-pop absolute bottom-full left-0 z-[9999] mb-2 overflow-hidden rounded-md border border-rp-danger-border bg-rp-surface shadow-e3"
          style={{
            width: Math.min(500, window.innerWidth - 60),
            maxHeight: 320,
          }}>
          <div className="flex items-center gap-2 border-b border-rp-danger-border bg-rp-danger-soft px-3 py-2">
            <AlertCircle />
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-rp-danger">Error Details</span>
          </div>
          <div className="p-3 overflow-auto" style={{ maxHeight: 270 }}>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-rp-danger">
              {detail}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

const RENDER_MODE_KEY = "runphantom:llm-render-mode";
const EMPTY_SUB_AGENTS: SubAgent[] = [];

function ChatItemList({ items, spans, subAgents, onDiveIn, md, onMdChange, onEditMessage, asSubAgent = false }: {
  items: ChatItem[]; spans: Span[]; subAgents: readonly SubAgent[]; onDiveIn?: (rootSpanId: string) => void;
  md: boolean; onMdChange?: (md: boolean) => void; onEditMessage?: (content: string) => void; asSubAgent?: boolean;
}) {
  let seenLLM = false;
  return items.map((item, i) => {
    const isFirstLLM = !!onMdChange && item.type === "llm_out" && !seenLLM;
    if (item.type === "llm_out") seenLLM = true;
    if (item.type === "tool_group") {
      return (
        <div key={`tg${i}`} className="flex flex-wrap gap-1.5 px-4 py-0.5 items-center">
          {item.items.map((gi, j) =>
            gi.type === "tool"
              ? <ToolCallPill key={gi.span.id} span={gi.span} />
              : <SubAgentBlock key={`sa${j}-${gi.agent.root_span_id}`} agent={gi.agent} spans={spans} subAgents={subAgents} onDiveIn={onDiveIn} />
          )}
          {item.liveTools?.map((lt, j) => lt.type === "live_tool_start" ? (
            <span key={`lts${j}`} className="inline-flex items-center gap-1.5 rounded-sm border border-rp-wash-border bg-rp-wash py-1 pl-2 pr-3 text-xs font-medium text-rp-blue">
              <Spinner style={{ marginRight: 3 }} />
              <span className="text-rp-ink">{lt.name}</span>
              {lt.argsPreview && <span className="font-normal text-rp-ink-muted">({lt.argsPreview})</span>}
            </span>
          ) : lt.type === "live_tool_result" ? (
            <span key={`ltr${j}`} className="inline-flex items-center gap-1.5 rounded-sm border border-rp-line bg-rp-surface px-2.5 py-1 text-xs font-medium text-rp-ink">
              <Check /> <span className="text-rp-ink">{lt.name}</span>
            </span>
          ) : null)}
        </div>
      );
    }

    if (item.type === "capture") return <div key={`cap-${item.span.id}`} className="px-4 py-1"><CaptureVisibilityDetails span={item.span} /></div>;

    if (item.type === "system_msg") {
      return (
        <div key={`sys${i}`} className="px-4 space-y-1.5">
          {item.content && <MessageList messages={[{ role: "system", content: item.content }]} />}
          {item.prevMessages && item.prevMessages.length > 0 && (
            <PreviousMessages messages={item.prevMessages} />
          )}
        </div>
      );
    }

    if (item.type === "user_msg") {
      if (asSubAgent) return <AgentPrompt key={`usr${i}`} content={item.content} />;
      return <UserMessage key={`usr${i}`} content={item.content} parts={item.parts} images={item.images} onEdit={item.independentObservation || item.fromAgentInput ? undefined : onEditMessage} />;
    }

    if (item.type === "llm_out") {
      const s = item.span;
      const isErr = s.status === "ERROR";
      const capture = s.normalized?.capture;
      const content = capture?.entityKind === "assistant" ? capture.assistantText : s.output_payload;
      return (
        <div key={`lo${i}`} className="px-4 py-2">
          {isFirstLLM && onMdChange && (
            <div className="mb-2 flex justify-start" data-testid="llm-render-mode-toolbar">
              <RenderModeToggle md={md} onChange={onMdChange} />
            </div>
          )}
          {isErr && content !== null && (
            <div className="max-w-[85%]"><LLMErrorBanner content={content} /></div>
          )}
          {capture?.entityKind === "assistant" && content === null && <div className="text-[12px] text-rp-ink-muted">Assistant observation · Text unavailable; inspect the captured span payload.</div>}
          {!isErr && content !== null && (
            <LLMOutput content={content} md={md} />
          )}
        </div>
      );
    }

    if (item.type === "llm_stop") {
      return (
        <div key={`ls${i}`} className="px-4 py-2" data-testid="llm-stop">
          {item.error
            ? <div className="max-w-[85%]"><LLMErrorBanner content={item.error} /></div>
            : <p role="status" className="max-w-[85%] text-[13px] leading-6 text-rp-ink-muted">
                No answer text. Generation stopped early: <span className="font-mono text-rp-ink">{item.reason}</span>
                {item.reasoningOnly && item.span.output_tokens != null ? `. All ${item.span.output_tokens.toLocaleString()} output tokens were reasoning.` : "."}
              </p>}
        </div>
      );
    }

    if (item.type === "reasoning") {
      return (
        <div key={`r${i}`} className="mx-4 my-1 whitespace-pre-wrap border-l-2 border-rp-line py-1 pl-3 text-[12px] italic leading-[1.6] text-rp-ink-muted">
          <SmoothTextDelta content={item.content} enabled={true} as="span" className="whitespace-pre-wrap" style={{ color: "inherit" }} />
        </div>
      );
    }

    if (item.type === "text_delta") {
      return (
        <div key={`td${i}`} className="px-4">
          <SmoothTextDelta content={item.content} enabled={true} />
        </div>
      );
    }

    return null;
  });
}

export function ChatFlow({ spans, liveEvents, subAgents = EMPTY_SUB_AGENTS, onDiveIn, isActive, lastUpdatedAt, onEditMessage, replayError, asSubAgent = false }: {
  spans: Span[]; liveEvents: LiveEvent[]; subAgents?: SubAgent[]; onDiveIn?: (rootSpanId: string) => void; isActive?: boolean; lastUpdatedAt?: number; onEditMessage?: (content: string) => void; replayError?: { code: string; message: string } | null;
  /** The transcript is a focused sub-agent's: its input came from the parent agent, not the user. */
  asSubAgent?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // An outer agent's span_ids include every inner agent's spans, so the
  // smallest agent holding a span owns it.
  const subAgentBySpan = useMemo(() => {
    const owner = new Map<string, string>();
    for (const agent of [...subAgents].sort((a, b) => b.span_ids.length - a.span_ids.length)) {
      for (const id of agent.span_ids) owner.set(id, agent.root_span_id);
    }
    return owner;
  }, [subAgents]);
  const [md, setMd] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(RENDER_MODE_KEY) !== "raw";
  });
  const handleMdChange = (next: boolean) => {
    setMd(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RENDER_MODE_KEY, next ? "markdown" : "raw");
    }
  };

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<AgentDisclosure["focus"]>(null);
  const toggle = useCallback((rootSpanId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(rootSpanId)) next.add(rootSpanId);
      return next;
    });
  }, []);

  // A Trajectory focus request for a span inside a sub-agent opens the card of
  // the innermost agent that owns it, and every card around that one.
  useEffect(() => {
    const handler = (e: Event) => {
      const spanId = (e as CustomEvent<{ spanId?: string }>).detail?.spanId;
      const owner = spanId ? subAgentBySpan.get(spanId) : undefined;
      if (!owner) return;
      const chain = subAgents.filter(agent => agent.span_ids.includes(owner)).map(agent => agent.root_span_id);
      setExpanded(prev => new Set([...prev, ...chain]));
      setFocus(prev => ({ rootSpanId: owner, request: (prev?.request ?? 0) + 1 }));
    };
    document.addEventListener("runphantom:focus-tool", handler);
    return () => document.removeEventListener("runphantom:focus-tool", handler);
  }, [subAgentBySpan, subAgents]);
  const disclosure = useMemo<AgentDisclosure>(() => ({ expanded, toggle, focus, md }), [expanded, toggle, focus, md]);

  const items = useMemo(() => buildChatItems({ spans, liveEvents, subAgents }), [spans, liveEvents, subAgents]);

  if (items.length === 0) {
    if (replayError) {
      return (
        <div className={cn("rp-fade-rise mx-4 my-6 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center text-[13px] text-rp-ink-muted", replayError.code === "replay_cancelled" ? "border-rp-line-dashed bg-rp-surface" : "border-rp-danger-border bg-rp-danger-soft")}>
          <div className={cn("font-display text-[17px] font-semibold tracking-[-0.02em]", replayError.code === "replay_cancelled" ? "text-rp-ink" : "text-rp-danger")}>
            {replayError.code === "replay_cancelled" ? "Replay cancelled" : "Replay failed"}
          </div>
          <div className="rp-meta">{replayError.code}</div>
          <div className="max-w-xl whitespace-pre-wrap text-[13px] leading-6 text-rp-ink">{replayError.message}</div>
        </div>
      );
    }
    if (spans.some(span => span.normalized?.capture)) {
      return (
        <div className="rp-fade-rise mx-4 my-6 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-rp-line-dashed bg-rp-surface px-6 py-10 text-center">
          <div className="font-display text-[17px] font-semibold tracking-[-0.02em] text-rp-ink">No model messages in the captured trace</div>
          <div role="status" className="rp-meta">Producer-reported observations · Partial capture · Runtime unverified</div>
          <div className="text-[13px] text-rp-ink-muted">Completion unverified. Captured spans are in the Span Tree tab.</div>
        </div>
      );
    }
    const roots = spans.filter(span => span.parent_span_id === null);
    const endedRoot = roots.length > 0 && roots.every(span => typeof span.start_time_ms === "number" && Number.isFinite(span.start_time_ms)
      && typeof span.end_time_ms === "number" && Number.isFinite(span.end_time_ms)
      && span.end_time_ms >= span.start_time_ms);
    if (!isActive) {
      return (
        <div className="rp-fade-rise mx-4 my-6 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-rp-line-dashed bg-rp-surface px-6 py-10 text-center">
          <div className="font-display text-[17px] font-semibold tracking-[-0.02em] text-rp-ink">No conversation in this trace</div>
          <div className="max-w-md text-[13px] leading-6 text-rp-ink-muted">
            {endedRoot
              ? "This run finished without recording any model messages. Its spans are in the Span Tree tab."
              : "No model messages were recorded. Completion is unverified. Its spans are in the Span Tree tab."}
          </div>
        </div>
      );
    }
    return (
      <div role="status" className="flex h-48 flex-col items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-rp-ink-muted">
        Waiting for activity <Dots />
      </div>
    );
  }

  return (
    <AgentDisclosureContext.Provider value={disclosure}>
      <div ref={scrollRef} className="space-y-1.5 py-2 pb-24">
        {spans.some(span => span.normalized?.capture) && <div role="status" className="rp-meta px-4">Producer-reported observations · Partial capture · Runtime unverified</div>}
        <div className="min-w-0 px-3 pt-1 sm:px-4"><FlameTimeline spans={spans} subAgents={subAgents} onDiveIn={onDiveIn} /></div>
        <ChatItemList items={items} spans={spans} subAgents={subAgents} onDiveIn={onDiveIn} md={md} onMdChange={handleMdChange} onEditMessage={onEditMessage} asSubAgent={asSubAgent} />
        <ActiveSpinner isActive={isActive} lastUpdatedAt={lastUpdatedAt} liveEvents={liveEvents} spans={spans} />
      </div>
    </AgentDisclosureContext.Provider>
  );
}
