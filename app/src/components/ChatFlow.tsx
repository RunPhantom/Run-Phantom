import { CaptureVisibilityDetails } from "./CaptureVisibilityDetails";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { argsPreview, displayPayload, fmt, MAX_INLINE_PAYLOAD, plural, trunc, tryJson } from "../utils/helpers";
import type { LiveEvent, Span, SubAgent } from "../utils/types";
import { Button } from "./Button";
import { FlameTimeline } from "./FlameTimeline";
import { AlertCircle, Check, Chevron, Dots, Spinner } from "./Icons";
import { Markdown } from "./Markdown";
import { MessageImages, MessageList, messagesFromSpan } from "./MessageList";
import { ToolCallPill } from "./ToolCallPill";
import { extractLiveToolArgs } from "./chat-flow-live";
import { useSmoothText } from "../hooks/use-smooth-text";
import { canEditReplayMessage } from "../utils/messageParsing";

type ToolGroupItem = { type: "tool"; span: Span } | { type: "sub_agent"; agent: SubAgent };
type LiveToolItem =
  | { type: "live_tool_start"; name: string; argsPreview: string | null; time: number }
  | { type: "live_tool_result"; name: string; time: number };

type ChatItem =
  | { type: "capture"; span: Span; time: number }
  | { type: "tool"; span: Span; time: number }
  | { type: "tool_group"; items: ToolGroupItem[]; time: number; liveTools?: LiveToolItem[] }
  | { type: "sub_agent"; agent: SubAgent; time: number }
  | { type: "user_msg"; content: string; parts?: string[]; images?: string[]; time: number; independentObservation?: boolean }
  | { type: "system_msg"; content: string; time: number; prevMessages?: { role: string; content: string }[] }
  | { type: "llm_out"; span: Span; time: number }
  | LiveToolItem
  | { type: "reasoning"; content: string; time: number }
  | { type: "text_delta"; content: string; time: number };

function isSyntheticPartialLlmSpan(span: Span): boolean {
  return span.id.startsWith("evt_") || span.span_type === "LLM";
}

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

function SubAgentBlock({ agent, spans, subAgentBySpan, onDiveIn }: { agent: SubAgent; spans: Span[]; subAgentBySpan: Map<string, string>; onDiveIn?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const a = agent;

  const agentSpanSet = new Set(a.span_ids);
  const rootSpan = spans.find(s => s.id === a.root_span_id);
  const agentToolSpans = spans.filter(s => agentSpanSet.has(s.id) && s.span_type === "TOOL_CALL" && s.id !== a.root_span_id);
  // Find sub-agent LLM spans for input/output (agent.subagent or nested generateText)
  const agentLLMs = spans.filter(s => agentSpanSet.has(s.id) && s.span_type?.includes("LLM") && s.id !== a.root_span_id);
  const agentInput = agentLLMs.find(s => s.input_payload)?.input_payload ?? rootSpan?.input_payload;
  const agentOutput = agentLLMs.find(s => s.output_payload);

  useEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const popH = 320;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      setPos({ top: spaceBelow >= popH ? rect.bottom + 4 : Math.max(4, rect.top - popH - 4), left: rect.left });
    }
  }, [open, focusRequest]);

  // The parent transcript renders none of this sub-agent's spans, so Trajectory
  // focus requests for any of them land on this chip. The scroll is instant
  // because the popover is fixed-positioned from the chip's settled rect.
  useEffect(() => {
    const handler = (e: Event) => {
      const spanId = (e as CustomEvent<{ spanId?: string }>).detail?.spanId;
      if (!spanId || subAgentBySpan.get(spanId) !== a.root_span_id || !btnRef.current) return;
      btnRef.current.scrollIntoView({ behavior: "instant", block: "center" });
      btnRef.current.focus({ preventScroll: true });
      setOpen(true);
      setFocusRequest(n => n + 1);
    };
    document.addEventListener("runphantom:focus-tool", handler);
    return () => document.removeEventListener("runphantom:focus-tool", handler);
  }, [a.root_span_id, subAgentBySpan]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (!btnRef.current?.contains(e.target as Node)) setOpen(false); };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        window.requestAnimationFrame(() => btnRef.current?.focus());
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open]);

  return (
    <div className="inline-block">
      <button ref={btnRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-rp-line bg-rp-surface px-2.5 py-1 text-xs font-medium text-rp-ink transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash aria-expanded:border-rp-wash-border aria-expanded:bg-rp-wash"
        onClick={() => setOpen(!open)}
      >
        <span className="rounded-sm bg-rp-wash px-1 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.08em] text-rp-blue">agent</span>
        <span className="text-rp-ink">{a.name}</span>
        <span className="rp-num text-[11px] text-rp-ink-muted">{plural(a.tool_count, "tool")} &middot; {fmt(a.duration_ms)}</span>
        <Chevron open={open} size={10} />
      </button>

        {open && pos && (
          <div
            className="rp-pop fixed z-[9999] flex flex-col rounded-md border border-rp-line bg-rp-surface shadow-e3"
            role="dialog"
            aria-label={`${a.name} sub-agent details`}
            style={{ top: pos.top, left: Math.max(16, Math.min(pos.left, window.innerWidth - Math.min(360, window.innerWidth - 32) - 16)), width: "min(360px, calc(100vw - 32px))", maxHeight: 340 }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="p-3 space-y-2 overflow-auto sb flex-1 min-h-0">
              {/* Input — shown as a user-message bubble */}
              {agentInput && (
                <div className="flex justify-end">
                  <div className="max-w-[90%] rounded-md border border-rp-line bg-rp-canvas-blue px-2.5 py-1.5">
                    <pre className="whitespace-pre-wrap font-sans text-[12px] leading-snug text-rp-ink">{trunc(agentInput, 150)}</pre>
                  </div>
                </div>
              )}

              {/* Tools */}
              {agentToolSpans.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agentToolSpans.map(s => (
                    <span key={s.id} className={cn("inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 font-mono text-[11px]", s.status === "ERROR" ? "border-rp-danger-border bg-rp-danger-soft text-rp-danger" : "border-rp-line bg-white text-rp-ink")}>
                      {s.status === "ERROR" ? <AlertCircle /> : <Check />} {s.name} <span className="text-rp-ink-muted">{fmt(s.duration_ms)}</span>
                    </span>
                  ))}
                </div>
              )}

              {/* Output */}
              {agentOutput?.output_payload && (
                <div>
                  <div className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted">Output</div>
                  <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-rp-ink">{trunc(agentOutput.output_payload, 150)}</pre>
                </div>
              )}

            </div>

            {/* Footer — always visible */}
            <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-t border-rp-line px-3 py-2">
              {onDiveIn ? (
                <Button className="shrink-0 whitespace-nowrap" onClick={() => { setOpen(false); onDiveIn(a.root_span_id); }}>
                  Open Sub-Agent &rarr;
                </Button>
              ) : <div />}
              <div className="rp-meta min-w-0 flex-1 break-words text-right text-[10px]">
                {a.model && <>{a.model} &middot; </>}
                {a.llm_count} LLM &middot; {plural(a.tool_count, "tool")} &middot; {fmt(a.duration_ms)}
                {a.total_input_tokens > 0 && <> &middot; {a.total_input_tokens.toLocaleString()} in</>}
                {a.total_output_tokens > 0 && <> &middot; {a.total_output_tokens.toLocaleString()} out</>}
              </div>
            </div>
          </div>
        )}
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
            className="absolute -bottom-2 -right-2 flex min-h-7 min-w-7 items-center justify-center rounded-control border border-rp-line bg-rp-surface text-rp-ink-muted opacity-0 transition-[opacity,background-color,color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash hover:text-rp-blue focus-visible:opacity-100 group-hover/usermsg:opacity-100"
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

export function ChatFlow({ spans, liveEvents, subAgents = EMPTY_SUB_AGENTS, onDiveIn, isActive, lastUpdatedAt, onEditMessage, replayError }: {
  spans: Span[]; liveEvents: LiveEvent[]; subAgents?: SubAgent[]; onDiveIn?: (rootSpanId: string) => void; isActive?: boolean; lastUpdatedAt?: number; onEditMessage?: (content: string) => void; replayError?: { code: string; message: string } | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // detectSubAgents also reports agents nested inside another, and the outer
  // agent's span_ids include the inner one's. The smallest agent holding a span
  // owns it, so a Trajectory focus request opens exactly one chip.
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

  const items = useMemo(() => {
    const all: ChatItem[] = [];

    const parentSpanIds = new Set(spans.map(s => s.id));
    const doChildNames = new Set(["ai.streamText.doStream", "ai.streamText.doGenerate", "ai.generateText.doGenerate"]);
    const llmSpans: Span[] = [];
    // Collect doStream/doGenerate children keyed by parent — they hold the full
    // conversation history (system prompt, previous messages, tool results) that
    // the parent span's ai.prompt doesn't include.
    const doChildrenByParent = new Map<string, Span[]>();

    // Sub-agent root spans render as agent blocks; their non-root spans are
    // hidden from the main view and only shown when the user dives in.
    const agentRootIds = new Set(subAgents.map(a => a.root_span_id));
    const agentSpanIds = new Set(subAgents.flatMap(a => a.span_ids));

    for (const span of spans) {
      if (agentSpanIds.has(span.id) && !agentRootIds.has(span.id)) continue;

      if (doChildNames.has(span.name) && span.parent_span_id && parentSpanIds.has(span.parent_span_id)) {
        const siblings = doChildrenByParent.get(span.parent_span_id) ?? [];
        siblings.push(span);
        doChildrenByParent.set(span.parent_span_id, siblings);
        continue;
      }

      const capture = span.normalized?.capture;
      if (capture?.entityKind === "prompt") {
        if (capture.userText !== null) all.push({ type: "user_msg", content: capture.userText, time: span.start_time_ms ?? 0, independentObservation: true });
        continue;
      }
      if (agentRootIds.has(span.id)) {
        const agent = subAgents.find(a => a.root_span_id === span.id)!;
        all.push({ type: "sub_agent", agent, time: span.start_time_ms });
      } else if (span.span_type === "TOOL_CALL") {
        all.push({ type: "tool", span, time: span.start_time_ms });
      } else if (span.span_type?.includes("LLM")) {
        llmSpans.push(span);
        if (span.captureVisibility?.stream) all.push({ type: "capture", span, time: span.start_time_ms });
      } else if (span.span_type === "RETRIEVAL" || span.span_type === "EMBEDDING") {
        all.push({ type: "capture", span, time: span.start_time_ms });
      }
    }

    const hasRealOtlpLlmSpan = llmSpans.some(span => !isSyntheticPartialLlmSpan(span));
    const visibleLlmSpans = hasRealOtlpLlmSpan
      ? llmSpans.filter(span => !isSyntheticPartialLlmSpan(span))
      : llmSpans;

    let prevMsgCount = 0;
    for (let i = 0; i < visibleLlmSpans.length; i++) {
      const span = visibleLlmSpans[i];
      if (span.normalized?.capture?.entityKind === "assistant") {
        all.push({ type: "llm_out", span, time: span.start_time_ms ?? 0 });
        continue;
      }
      // Prefer the richest child span's messages — the last doStream/doGenerate
      // child has the full conversation including system prompt, all previous
      // messages, and tool results. Fall back to the parent span if no children.
      const children = doChildrenByParent.get(span.id);
      const richestChild = children?.length ? children[children.length - 1] : null;
      const firstChild = children?.length ? children[0] : null;
      const messages = (richestChild ? messagesFromSpan(richestChild) : null) ?? messagesFromSpan(span);
      // For the first LLM call's messages use the first child (initial prompt),
      // since richestChild may include tool-result context from later steps.
      const firstMessages = (firstChild ? messagesFromSpan(firstChild) : null) ?? messagesFromSpan(span);
      if (messages && messages.length > 0) {
        const systemMsgs = messages.filter(m => m.role === "system");
        const nonSystem = messages.filter(m => m.role !== "system");
        if (i === 0) {
          // Use firstMessages for the initial user message extraction
          const initMsgs = firstMessages ?? messages;
          const initNonSystem = initMsgs.filter(m => m.role !== "system");
          const lastUserIdx = initNonSystem.reduce((acc, m, idx) => m.role === "user" ? idx : acc, -1);
          const prevMessages = lastUserIdx > 0 ? initNonSystem.slice(0, lastUserIdx) : [];
          if (systemMsgs.length > 0 || prevMessages.length > 0) {
            all.push({ type: "system_msg", content: systemMsgs.length > 0 ? systemMsgs.map(m => m.content).join("\n\n") : "", time: span.start_time_ms - 2, prevMessages: prevMessages.length > 0 ? prevMessages : undefined });
          }
        }
        const newMsgs = i === 0 ? nonSystem : nonSystem.slice(Math.max(0, prevMsgCount - systemMsgs.length));
        const lastUser = newMsgs.filter(m => m.role === "user").pop();
        if (lastUser) all.push({ type: "user_msg", content: lastUser.content, parts: lastUser.parts, images: lastUser.images, time: span.start_time_ms });
        prevMsgCount = messages.length;
      } else if (span.input_payload) {
        all.push({ type: "user_msg", content: span.input_payload, time: span.start_time_ms });
      }
      // Add outputs from each doStream/doGenerate child (each is a separate
      // LLM call — e.g. before tool use and after). Fall back to the parent
      // span's output when no child carries an output_payload, so a completed
      // turn always has something to render even if children only captured
      // tool calls / reasoning.
      const childrenWithOutput = children?.filter(c => c.output_payload) ?? [];
      if (childrenWithOutput.length > 0) {
        for (const child of childrenWithOutput) {
          all.push({ type: "llm_out", span: child, time: child.end_time_ms });
        }
      } else if (span.output_payload) {
        all.push({ type: "llm_out", span, time: span.end_time_ms });
      }
    }

    // A text_delta is superseded only when an llm_out item will render the
    // same text in its place. Suppressing purely by timestamp dropped text
    // when the corresponding span shipped without an output_payload, leaving
    // the turn blank. Track the end times of the spans we'll actually render
    // as llm_out items, and only drop deltas covered by those.
    const renderedLLMEndTimes = all.flatMap(item => item.type === "llm_out" ? [item.span.end_time_ms] : []);

    const completedCounts = new Map<string, number>();
    for (const s of spans) {
      if (s.span_type === "TOOL_CALL" && s.end_time_ms) {
        completedCounts.set(s.name, (completedCounts.get(s.name) ?? 0) + 1);
      }
    }
    const seenStart = new Map<string, number>();
    const seenResult = new Map<string, number>();

    const spanById = new Map(spans.map(s => [s.id, s]));

    for (const evt of liveEvents) {
      if (evt.type === "tool_start" || evt.type === "tool_result") {
        // For tool_start, content is the tool name.
        // For tool_result, content is the result data; look up tool name from the span.
        const name = evt.type === "tool_start"
          ? (evt.content ?? "")
          : (evt.span_id ? spanById.get(evt.span_id)?.name : null) ?? "";
        if (!name) continue;
        const map = evt.type === "tool_start" ? seenStart : seenResult;
        const n = (map.get(name) ?? 0) + 1;
        map.set(name, n);
        if (n <= (completedCounts.get(name) ?? 0)) continue;
        if (evt.type === "tool_start") {
          all.push({ type: "live_tool_start", name, argsPreview: argsPreview(extractLiveToolArgs(evt.metadata)), time: evt.timestamp });
        }
        if (evt.type === "tool_result") all.push({ type: "live_tool_result", name, time: evt.timestamp });
      } else if (evt.type === "reasoning" || evt.type === "reasoning-delta" || evt.type === "reasoning_delta") {
        // Reasoning is kept even after completion — it's valuable context.
        all.push({ type: "reasoning", content: evt.content ?? "", time: evt.timestamp });
      } else if (evt.type === "text_delta") {
        const superseded = renderedLLMEndTimes.some(t => evt.timestamp <= t);
        if (!superseded) {
          all.push({ type: "text_delta", content: evt.content ?? "", time: evt.timestamp });
        }
      }
    }

    // Tie-break by item role so a turn's input → work → output ordering is
    // preserved even when timestamps coincide (e.g. the synthetic LLM span
    // shares its start_time with the first tool span on fast turns).
    const chatItemPriority = (t: ChatItem["type"]): number => {
      if (t === "user_msg" || t === "system_msg") return 0;
      if (t === "llm_out") return 2;
      return 1;
    };
    all.sort((a, b) => (a.time - b.time) || (chatItemPriority(a.type) - chatItemPriority(b.type)));

    const grouped: ChatItem[] = [];
    let tg: { type: "tool_group"; items: ToolGroupItem[]; time: number; liveTools?: LiveToolItem[] } | null = null;
    for (const item of all) {
      if (item.type === "tool" || item.type === "sub_agent" || item.type === "live_tool_start" || item.type === "live_tool_result") {
        if (!tg) tg = { type: "tool_group", items: [], time: item.time };
        if (item.type === "tool") tg.items.push({ type: "tool", span: item.span });
        else if (item.type === "sub_agent") tg.items.push({ type: "sub_agent", agent: item.agent });
        else { if (!tg.liveTools) tg.liveTools = []; tg.liveTools.push(item); }
      } else {
        if (tg) { grouped.push(tg); tg = null; }
        grouped.push(item);
      }
    }
    if (tg) grouped.push(tg);

    const merged: ChatItem[] = [];
    for (const item of grouped) {
      const prev = merged[merged.length - 1];
      if (item.type === "reasoning" && prev?.type === "reasoning") {
        prev.content += item.content;
      } else if (item.type === "text_delta" && prev?.type === "text_delta") {
        prev.content += item.content;
      } else {
        merged.push(item);
      }
    }
    return merged;
  }, [spans, liveEvents, subAgents]);

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

  const hasLLMOutput = items.some(it => it.type === "llm_out");

  return (
    <div ref={scrollRef} className="space-y-1.5 py-2 pb-24">
      {spans.some(span => span.normalized?.capture) && <div role="status" className="rp-meta px-4">Producer-reported observations · Partial capture · Runtime unverified</div>}
      <div className="min-w-0 px-3 pt-1 sm:px-4"><FlameTimeline spans={spans} subAgents={subAgents} onDiveIn={onDiveIn} /></div>
      {(() => { let seenLLM = false; return items.map((item, i) => {
        const isFirstLLM = hasLLMOutput && item.type === "llm_out" && !seenLLM;
        if (item.type === "llm_out") seenLLM = true;
        if (item.type === "tool_group") {
          return (
            <div key={`tg${i}`} className="flex flex-wrap gap-1.5 px-4 py-0.5 items-center">
              {item.items.map((gi, j) =>
                gi.type === "tool"
                  ? <ToolCallPill key={gi.span.id} span={gi.span} />
                  : <SubAgentBlock key={`sa${j}`} agent={gi.agent} spans={spans} subAgentBySpan={subAgentBySpan} onDiveIn={onDiveIn} />
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
          return <UserMessage key={`usr${i}`} content={item.content} parts={item.parts} images={item.images} onEdit={item.independentObservation ? undefined : onEditMessage} />;
        }

        if (item.type === "llm_out") {
          const s = item.span;
          const isErr = s.status === "ERROR";
          const capture = s.normalized?.capture;
          const content = capture?.entityKind === "assistant" ? capture.assistantText : s.output_payload;
          return (
            <div key={`lo${i}`} className="px-4 py-2">
              {isFirstLLM && (
                <div className="mb-2 flex justify-start" data-testid="llm-render-mode-toolbar">
                  <RenderModeToggle md={md} onChange={handleMdChange} />
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
      }); })()}
      <ActiveSpinner isActive={isActive} lastUpdatedAt={lastUpdatedAt} liveEvents={liveEvents} spans={spans} />
    </div>
  );
}
