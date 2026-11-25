import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ChevronRight, Link2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, displayPayload, detectProvider, isoTimestamp } from "../../utils/helpers";
import { parseSpanAttributes, requestedToolCalls, spanFinishReasons, spanReasoningTokens, stoppedEarlyReason } from "../../utils/span-evidence";
import type { NormalizedMessage, Span } from "../../utils/types";
import { JsonView } from "../JsonView";
import { Markdown } from "../Markdown";
import { GuardDecisions } from "../GuardDecisions";
import { CaptureVisibilityDetails } from "../CaptureVisibilityDetails";
import { spanCost } from "../../../../src/pricing/span-cost";
import { fmtCost } from "../../utils/costs";
import { CopyButton } from "./CopyButton";
import { useSpanActions, type SpanAction } from "./span-actions";
import { availableTools, looksLikeMarkdown, payloadShape, previewValue, providerOptions, stepAsJson, stepLink } from "./span-details";
import { readableError, spanErrorText, traceKind, TRACE_KIND_LABEL, type TraceKind } from "./trace-model";

const RENDER_MODE_KEY = "runphantom:span-drawer:render";
type RenderMode = "pretty" | "raw";

function readRenderMode(): RenderMode {
  try { return localStorage.getItem(RENDER_MODE_KEY) === "raw" ? "raw" : "pretty"; } catch { return "pretty"; }
}

const KIND_SWATCH: Record<TraceKind, string> = {
  llm: "var(--rp-trace-llm)", tool: "var(--rp-trace-tool)", agent: "var(--rp-trace-agent)", other: "var(--rp-trace-other)",
};

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("font-mono text-11 font-medium uppercase tracking-[0.12em] text-rp-ink-subtle", className)}>{children}</div>;
}

function RenderToggle({ mode, onChange }: { mode: RenderMode; onChange: (mode: RenderMode) => void }) {
  return (
    <div role="group" aria-label="Payload view" className="inline-flex min-h-6 overflow-hidden rounded-control border border-rp-line">
      {(["pretty", "raw"] as const).map(option => (
        <button key={option} type="button" aria-pressed={mode === option} onClick={() => onChange(option)}
          className={cn("px-2 text-11 transition-colors duration-fast", mode === option ? "bg-rp-wash text-rp-blue" : "bg-rp-surface text-rp-ink-subtle hover:text-rp-ink")}>
          {option === "pretty" ? "Formatted" : "Raw"}
        </button>
      ))}
    </div>
  );
}

function MessageTranscript({ messages }: { messages: NormalizedMessage[] }) {
  return (
    <ol className="space-y-3">
      {messages.map((message, index) => (
        <li key={index} className="min-w-0">
          <Eyebrow className={cn("mb-1", message.role === "assistant" && "text-rp-blue")}>{message.role}{message.toolCallId ? ` · ${message.toolCallId}` : ""}</Eyebrow>
          {message.role === "tool" || message.role === "system"
            ? <details className="group/msg rounded-sm border border-rp-line-muted bg-rp-canvas px-2.5 py-1.5" open={message.role === "tool" ? false : message.content.length < 600}>
                <summary className="cursor-pointer list-none truncate text-12 text-rp-ink-subtle group-open/msg:mb-1.5">
                  <ChevronRight aria-hidden="true" className="mr-1 inline size-3 transition-transform group-open/msg:rotate-90" />
                  {message.content.split("\n")[0]!.slice(0, 120) || "(empty)"}
                </summary>
                <PayloadText text={message.content} mode="pretty" prose={message.role !== "tool"} />
              </details>
            : <PayloadText text={message.content} mode="pretty" prose />}
        </li>
      ))}
    </ol>
  );
}

/** `prose` sets model text in the reading face; tool payloads and raw views stay monospaced. */
function PayloadText({ text, mode, prose = false }: { text: string; mode: RenderMode; prose?: boolean }) {
  const shown = displayPayload(text) ?? "";
  if (mode === "pretty" && looksLikeMarkdown(text)) {
    return <div className="rp-drawer-markdown min-w-0 text-14 leading-6 text-rp-ink"><Markdown>{shown}</Markdown></div>;
  }
  if (mode === "pretty" && prose) return <p className="whitespace-pre-wrap break-words text-14 leading-6 text-rp-ink">{shown}</p>;
  return <pre className="whitespace-pre-wrap break-words font-mono text-12 leading-5 text-rp-ink">{shown}</pre>;
}

function Payload({ payload, mode, messages, prose = false }: { payload: string; mode: RenderMode; messages?: NormalizedMessage[]; prose?: boolean }) {
  if (mode === "pretty" && messages?.length) return <MessageTranscript messages={messages} />;
  const shape = payloadShape(payload);
  if (shape.kind === "json") {
    if (mode === "raw") return <pre className="whitespace-pre-wrap break-words font-mono text-12 leading-5 text-rp-ink">{displayPayload(payload)}</pre>;
    return <JsonView data={shape.value} maxExpand={2} copyable />;
  }
  return <PayloadText text={shape.text} mode={mode} prose={prose} />;
}

function Section({ title, actions, children, id }: { title: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-2">
        <div id={id} className="font-mono text-11 font-medium uppercase tracking-[0.12em] text-rp-ink-subtle">{title}</div>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Collapsible({ title, preview, children, defaultOpen = false }: { title: string; preview?: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" aria-expanded={open} className="flex min-h-7 w-full items-center gap-2 text-left" onClick={() => setOpen(value => !value)}>
        <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-rp-ink-subtle transition-transform duration-fast", open && "rotate-90")} />
        <span className="shrink-0 font-mono text-11 font-medium uppercase tracking-[0.12em] text-rp-ink-subtle">{title}</span>
        {!open && preview && <span className="min-w-0 flex-1 truncate text-12 text-rp-ink-subtle">{preview}</span>}
      </button>
      {open && <div className="mt-1.5 rounded-sm border border-rp-line bg-rp-canvas p-2.5">{children}</div>}
    </div>
  );
}

// The last 12 characters turned "demo_review_tool-1" into "eview_tool-1",
// which reads as a mangled word. Show the whole id and let CSS add the
// ellipsis when the column is genuinely too narrow.
function SpanIdCopy({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);
  useEffect(() => () => { if (resetRef.current) window.clearTimeout(resetRef.current); }, []);
  return (
    <button
      type="button"
      className={cn("w-full min-w-0 truncate rounded-sm text-left transition-colors duration-fast hover:text-rp-blue", copied ? "text-rp-success" : "text-rp-ink")}
      title={id}
      aria-label={`Copy span id ${id}`}
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          if (resetRef.current) window.clearTimeout(resetRef.current);
          resetRef.current = window.setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
    >
      {id}
    </button>
  );
}

export type DrawerMode = "docked" | "sheet";

export interface SpanDrawerProps {
  span: Span;
  spans: readonly Span[];
  agentRootIds?: ReadonlySet<string>;
  traceStart: number;
  mode: DrawerMode;
  onClose: () => void;
  /** Counted (top-level) model call, so a cost shown here adds up to the run total. */
  counted: boolean;
}

export function SpanDrawer({ span, spans, agentRootIds, traceStart, mode, onClose, counted }: SpanDrawerProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [renderMode, setRenderMode] = useState<RenderMode>(readRenderMode);
  const changeRenderMode = (next: RenderMode) => {
    setRenderMode(next);
    try { localStorage.setItem(RENDER_MODE_KEY, next); } catch { /* storage unavailable */ }
  };
  const kind = traceKind(span, agentRootIds);
  const isErr = span.status === "ERROR";
  const errorReason = isErr ? spanErrorText(span) : "";
  const readable = isErr ? readableError(span, 400) : "";
  const attrs = useMemo(() => parseSpanAttributes(span.attributes), [span.attributes]);
  const isLlm = !!span.span_type?.includes("LLM");
  const evidence = useMemo(() => {
    const llmAttrs = isLlm ? attrs : null;
    const finishReasons = spanFinishReasons(llmAttrs);
    return {
      finishReasons,
      stoppedEarly: stoppedEarlyReason(finishReasons),
      reasoningTokens: spanReasoningTokens(llmAttrs),
      requested: requestedToolCalls(llmAttrs),
      available: isLlm ? availableTools(attrs) : [],
    };
  }, [attrs, isLlm]);
  const cost = useMemo(() => (isLlm ? spanCost(span) : null), [isLlm, span]);
  const options = useMemo(() => providerOptions(attrs), [attrs]);
  const messages = span.normalized?.kind === "llm" && span.normalized.messages.length ? span.normalized.messages : undefined;
  const runId = span.run_id;
  const actions = useSpanActions({ span, spans, runId, navigate });
  const provider = detectProvider(span.model, span.provider);
  const backRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => { setActionError(null); }, [span.id]);

  // In the sheet the header is sticky inside the scroller; without matching
  // scroll padding, tabbing to a control just below it left that control
  // half hidden under the header.
  useLayoutEffect(() => {
    const element = headerRef.current;
    if (mode !== "sheet" || !element) return;
    const measure = () => setHeaderHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  // An action's failure is shown beside the buttons; a rejected promise from
  // an extension must not end up as an unhandled rejection the reader never sees.
  const runAction = (action: SpanAction) => {
    setActionError(null);
    Promise.resolve()
      .then(() => action.run({ span, spans, runId, navigate }))
      .catch((error: unknown) => {
        console.error(`Span action "${action.id}" failed`, error);
        const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
        setActionError(`${action.label} failed${detail}`);
      });
  };

  useEffect(() => {
    if (mode === "sheet") requestAnimationFrame(() => backRef.current?.focus());
  }, [mode, span.id]);

  const calledNames = [...new Set(evidence.requested.map(call => call.name))];
  const outputIsError = isErr && !!span.output_payload && errorReason === span.output_payload;
  const attributeCount = attrs ? Object.keys(attrs).length : 0;
  const offset = span.start_time_ms - traceStart;

  const metaParts: ReactNode[] = [
    <span key="dur" className="font-mono tabular-nums">{fmt(span.duration_ms)}</span>,
    <span key="offset" className="font-mono tabular-nums" title="Start, relative to the start of the run">+{fmt(Math.max(0, offset))}</span>,
  ];
  if (span.model) metaParts.push(<span key="model" className="truncate font-mono">{span.model}</span>);
  if (span.input_tokens != null || span.output_tokens != null) {
    metaParts.push(<span key="tok" className="font-mono tabular-nums">{span.input_tokens?.toLocaleString() ?? "?"} in / {span.output_tokens?.toLocaleString() ?? "?"} out</span>);
  }
  if (cost && counted) {
    metaParts.push(cost.usd != null
      ? <span key="cost" className="font-mono tabular-nums" title={cost.source === "reported" ? "Reported by the provider" : "Estimated at list price"}>{fmtCost(cost.usd)}{cost.source === "list-price" ? " est." : ""}</span>
      : <span key="cost" title="No reported cost and no list price for this call">Cost unknown</span>);
  }

  const header = (
    <div ref={headerRef} className={cn("flex-shrink-0 border-b border-rp-line bg-rp-surface px-4 pb-2.5 pt-2.5", mode === "sheet" && "sticky top-0 z-10")}>
      {mode === "sheet" && (
        <button ref={backRef} type="button" onClick={onClose}
          className="-ml-2 mb-1.5 inline-flex min-h-10 items-center gap-1.5 rounded-control px-2 text-13 font-medium text-rp-ink hover:bg-rp-row-hover">
          <ArrowLeft aria-hidden="true" className="size-3.5 text-rp-ink-subtle" />
          Back to span list
        </button>
      )}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: KIND_SWATCH[kind] }} />
            <span className="font-mono text-11 tracking-[0.06em] text-rp-ink-subtle">{TRACE_KIND_LABEL[kind]}</span>
            {isErr
              ? <span className="rounded-sm bg-rp-danger-soft px-1.5 py-px font-mono text-11 font-medium tracking-[0.06em] text-rp-danger">ERROR</span>
              : <span className="rounded-sm bg-rp-success-soft px-1.5 py-px font-mono text-11 font-medium tracking-[0.06em] text-rp-success">OK</span>}
            {provider && <span className="rounded-sm border border-rp-line px-1.5 py-px text-11 text-rp-ink-subtle">{provider.label}</span>}
          </div>
          <h3 className="mt-1 break-words font-display text-17 font-semibold leading-6 tracking-[-0.01em] text-rp-ink">{span.name}</h3>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {actions.map(action => {
            const Icon = action.icon;
            return (
              <button key={action.id} type="button" data-span-action={action.id}
                onClick={() => runAction(action)}
                className="inline-flex h-7 items-center gap-1 rounded-control border border-rp-line px-2 text-12 font-medium text-rp-ink hover:bg-rp-row-hover">
                {Icon && <Icon aria-hidden="true" className="size-3.5" />}
                {action.label}
              </button>
            );
          })}
          <CopyButton value={() => stepAsJson(span)} label="Copy step as JSON" />
          <CopyButton value={() => stepLink(window.location.origin, location.pathname, location.search, span.id)} label="Copy link to step" icon={Link2} />
          {mode !== "sheet" && (
            <button type="button" aria-label="Close step details" title="Close (Esc)" onClick={onClose}
              className="inline-flex size-7 items-center justify-center rounded-control text-rp-ink-subtle hover:bg-rp-row-hover hover:text-rp-ink">
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-12 text-rp-ink-subtle">
        {metaParts.map((part, index) => <span key={index} className="inline-flex min-w-0 items-center">{part}</span>)}
      </div>
      {actionError && <p role="alert" data-span-action-error className="mt-1.5 break-words text-12 text-rp-danger">{actionError}</p>}
    </div>
  );

  const body = (
    <div className="space-y-4 px-4 py-3.5">
      {errorReason && (
        <div className="rounded-sm border border-rp-danger-border bg-rp-danger-soft p-3">
          <div className="mb-1 flex items-center gap-1.5 font-mono text-11 font-medium uppercase tracking-[0.12em] text-rp-danger">
            <AlertTriangle aria-hidden="true" className="size-3.5" />Error
            <CopyButton value={errorReason} label="Copy error" className="ml-auto text-rp-danger hover:text-rp-danger" />
          </div>
          {readable && readable !== errorReason.trim() && <p className="mb-2 text-13 font-medium leading-5 text-rp-danger">{readable}</p>}
          {readable && readable !== errorReason.trim()
            ? <details className="group/err"><summary className="cursor-pointer text-12 text-rp-danger underline-offset-4 hover:underline">Full error</summary>
                <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-12 leading-5 text-rp-danger">{displayPayload(errorReason)}</pre>
              </details>
            : <pre className="whitespace-pre-wrap break-words font-mono text-12 leading-5 text-rp-danger">{displayPayload(errorReason)}</pre>}
        </div>
      )}

      {evidence.stoppedEarly && (
        <div role="status" className="rounded-sm border border-rp-line bg-rp-canvas p-3 text-13 leading-5 text-rp-ink">
          Generation stopped early: <span className="font-mono">{evidence.stoppedEarly}</span>
          {evidence.reasoningTokens !== null && span.output_tokens != null && evidence.reasoningTokens >= span.output_tokens && span.output_tokens > 0
            ? ". Every reported output token was reasoning, so no answer text was produced."
            : "."}
        </div>
      )}

      {span.input_payload && (
        <Section id={`span-input-${span.id}`} title="Input"
          actions={<><RenderToggle mode={renderMode} onChange={changeRenderMode} /><CopyButton value={span.input_payload} label="Copy span input" /></>}>
          <div className="rounded-sm border border-rp-line bg-rp-canvas p-2.5"><Payload payload={span.input_payload} mode={renderMode} messages={messages} prose={isLlm} /></div>
        </Section>
      )}

      {span.output_payload && !outputIsError && (
        <Section id={`span-output-${span.id}`} title="Output"
          actions={<>{!span.input_payload && <RenderToggle mode={renderMode} onChange={changeRenderMode} />}<CopyButton value={span.output_payload} label="Copy span output" /></>}>
          <div className="rounded-sm border border-rp-line bg-rp-canvas p-2.5"><Payload payload={span.output_payload} mode={renderMode} prose={isLlm} /></div>
        </Section>
      )}

      {evidence.requested.length > 0 && !span.output_payload && (
        <Section id={`span-calls-${span.id}`} title="Output · requested tool calls" actions={<CopyButton value={JSON.stringify(evidence.requested, null, 2)} label="Copy span tool calls" />}>
          <div className="rounded-sm border border-rp-line bg-rp-canvas p-2.5"><JsonView data={evidence.requested} copyable /></div>
        </Section>
      )}

      {isLlm && (evidence.available.length > 0 || calledNames.length > 0) && (
        <Section id={`span-tools-${span.id}`} title={`Tools · ${calledNames.length} called of ${Math.max(evidence.available.length, calledNames.length)} available`}>
          <ul className="flex flex-wrap gap-1.5" aria-label="Tools offered to the model">
            {[...new Set([...evidence.available, ...calledNames])].map(name => {
              const called = calledNames.includes(name);
              return (
                <li key={name} className={cn("inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-12",
                  called ? "border-rp-wash-border bg-rp-wash text-rp-ink" : "border-rp-line text-rp-ink-subtle")}>
                  {name}{called && <span className="font-sans text-11 text-rp-blue">called</span>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section id={`span-timing-${span.id}`} title="Timing and usage">
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-4 gap-y-1.5 font-mono text-12 tabular-nums">
          <div className="text-rp-ink-subtle">duration</div>
          <div className="text-rp-ink">{fmt(span.duration_ms)}</div>
          <div className="text-rp-ink-subtle">starts at</div>
          <div className="text-rp-ink">+{fmt(Math.max(0, offset))}</div>
          {span.model && <><div className="text-rp-ink-subtle">model</div><div className="break-words text-rp-ink">{span.model}</div></>}
          {span.input_tokens != null && <><div className="text-rp-ink-subtle">input tokens</div><div className="text-rp-ink">{span.input_tokens.toLocaleString()}</div></>}
          {span.output_tokens != null && <><div className="text-rp-ink-subtle">output tokens</div><div className="text-rp-ink">{span.output_tokens.toLocaleString()}</div></>}
          {evidence.reasoningTokens !== null && <><div className="text-rp-ink-subtle">reasoning tokens</div><div className="text-rp-ink">{evidence.reasoningTokens.toLocaleString()}</div></>}
          {cost && counted && <><div className="text-rp-ink-subtle">cost</div><div className="text-rp-ink">{cost.usd != null ? `${fmtCost(cost.usd)} ${cost.source === "reported" ? "reported" : "estimated at list price"}` : "unknown"}</div></>}
          {cost && !counted && <><div className="text-rp-ink-subtle">cost</div><div className="text-rp-ink-subtle">counted on the parent call</div></>}
          {evidence.finishReasons.length > 0 && <><div className="text-rp-ink-subtle">finish reason</div><div className="break-words text-rp-ink">{evidence.finishReasons.join(", ")}</div></>}
          <div className="text-rp-ink-subtle">status</div>
          <div className={isErr ? "text-rp-danger" : "text-rp-ink"}>{span.status}</div>
          <div className="text-rp-ink-subtle">start</div>
          <div className="break-words text-rp-ink">{isoTimestamp(span.start_time_ms)}</div>
          <div className="text-rp-ink-subtle">end</div>
          <div className="break-words text-rp-ink">{isoTimestamp(span.end_time_ms)}</div>
          <div className="self-center text-rp-ink-subtle">span id</div>
          <SpanIdCopy id={span.id} />
          {span.parent_span_id && <><div className="text-rp-ink-subtle">parent id</div><div className="truncate text-rp-ink" title={span.parent_span_id}>{span.parent_span_id}</div></>}
          {typeof attrs?.["ai.provider.baseURL"] === "string" && <><div className="text-rp-ink-subtle">base url</div><div className="break-words text-rp-ink-subtle">{attrs["ai.provider.baseURL"] as string}</div></>}
        </div>
      </Section>

      {options && (
        <Collapsible title={options.title} preview={Object.entries(options.options).map(([key, value]) => `${key}: ${previewValue(value)}`).join("  ·  ")}>
          <JsonView data={options.options} maxExpand={10} copyable />
        </Collapsible>
      )}

      {attrs && attributeCount > 0 && (
        <Collapsible title={`Details · ${attributeCount} ${attributeCount === 1 ? "attribute" : "attributes"}`}>
          <div className="mb-2 flex justify-end"><CopyButton value={span.attributes ?? ""} label="Copy all attributes" /></div>
          <JsonView data={attrs} maxExpand={1} copyable />
        </Collapsible>
      )}

      <GuardDecisions evidence={span.guardEvidence} />
      <CaptureVisibilityDetails span={span} />
    </div>
  );

  return (
    <div role="region" aria-label="Span details" data-span-drawer={mode} className="flex h-full min-h-0 min-w-0 flex-col bg-rp-surface">
      {mode === "sheet" ? (
        <div className="sb min-h-0 flex-1 overflow-auto" style={{ scrollPaddingTop: headerHeight + 8 }}>{header}{body}</div>
      ) : (
        <>
          {header}
          <div className="sb min-h-0 flex-1 overflow-auto">{body}</div>
        </>
      )}
    </div>
  );
}
