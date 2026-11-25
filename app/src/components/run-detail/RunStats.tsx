import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, plural, spanErrorReason } from "../../utils/helpers";
import type { Span } from "../../utils/types";
import { getPricingSnapshot, getRunCostRows, subscribePricing, summarizeRunCost, fmtCost, fmtRate, type ModelCostRow } from "../../utils/costs";
import { PRICE_TABLE_AS_OF } from "../../../../src/pricing/list-prices";
import { countedLlmSpans, distinctModels } from "./trace-model";

const TOKEN_NUMBER_FLOW_TIMING = {
  spinTiming: { duration: 450, easing: "ease-out" },
  transformTiming: { duration: 250, easing: "ease-out" },
} as const;
function ErrorMessage({ span }: { span: Span }) {
  const msg = spanErrorReason(span);
  if (!msg) return null;
  return (
    <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-[18px] text-rp-danger">
      {String(msg).length > 200 ? String(msg).slice(0, 200) + "\u2026" : String(msg)}
    </div>
  );
}

const ERRORS_TOOLTIP_VIEWPORT_GAP = 12;
const ERRORS_TOOLTIP_MIN_HEIGHT = 96;

function ErrorsTooltip({ spans }: { spans: Span[] }) {
  const [show, setShow] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number>();
  const [scrollable, setScrollable] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Escape returns focus to the trigger, whose focus handler would otherwise
  // reopen the tooltip that was just dismissed.
  const dismissedRef = useRef(false);
  const errorSpans = useMemo(() => spans.filter(s => s.status === "ERROR"), [spans]);

  // A fixed 300px list cut its last line through the glyphs, and overlay
  // scrollbars gave no sign the rest existed. Size to the viewport instead,
  // and only scroll (with a visible hint) when the viewport is genuinely short.
  useLayoutEffect(() => {
    if (!show) return;
    const place = () => {
      const bottom = triggerRef.current?.getBoundingClientRect().bottom ?? 0;
      setMaxHeight(Math.max(ERRORS_TOOLTIP_MIN_HEIGHT, window.innerHeight - bottom - ERRORS_TOOLTIP_VIEWPORT_GAP));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [show]);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setScrollable(list.scrollHeight > list.clientHeight + 1);
    setMoreBelow(list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }, []);

  useLayoutEffect(() => {
    if (show) measure();
  }, [show, maxHeight, errorSpans, measure]);

  if (errorSpans.length === 0) return null;

  return (
    <span ref={triggerRef} className="relative cursor-help" tabIndex={0} aria-label={`${plural(errorSpans.length, "run error")}. Focus for details.`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setShow(false);
      }}
      onFocus={() => {
        if (dismissedRef.current) dismissedRef.current = false;
        else setShow(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShow(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !show) return;
        event.stopPropagation();
        setShow(false);
        if (document.activeElement !== triggerRef.current) {
          dismissedRef.current = true;
          triggerRef.current?.focus();
        }
      }}>
      <span className="font-medium text-rp-danger underline decoration-rp-danger-border decoration-dotted underline-offset-4"><NumberFlow value={errorSpans.length} /> error{errorSpans.length !== 1 ? "s" : ""}</span>
      {show && (
        // Padding rather than margin bridges the gap, so moving the pointer
        // onto the tooltip to scroll it does not fire mouseleave on the way.
        <div className="absolute left-0 top-full z-50 pt-1">
          <div className="flex flex-col overflow-hidden rounded-md border border-rp-danger-border bg-rp-surface shadow-e3"
            style={{
              width: "min(380px, calc(100vw - 32px))", maxHeight,
            }}>
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-rp-danger-border bg-rp-danger-soft px-3 py-2">
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--rp-danger)" strokeWidth={2.5} strokeLinecap="round">
                <circle cx={12} cy={12} r={10} /><line x1={12} y1={8} x2={12} y2={12} /><line x1={12} y1={16} x2={12.01} y2={16} />
              </svg>
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-rp-danger">
                {errorSpans.length} Error{errorSpans.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="relative flex min-h-0 flex-col">
              <div ref={listRef} role="region" aria-label="Error details" tabIndex={scrollable ? 0 : undefined}
                className="min-h-0 overflow-auto" onScroll={measure}>
                {errorSpans.map((s, idx) => (
                  <div key={s.id} className={cn("px-3 py-2.5", idx < errorSpans.length - 1 && "border-b border-rp-line-muted")}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={cn("rounded-sm px-1 py-0.5 font-mono text-[10px] font-medium tracking-[0.08em]", s.span_type?.includes("LLM") ? "bg-rp-wash text-rp-blue" : "bg-[color:var(--rp-n4)] text-rp-ink-muted")}>
                        {s.span_type === "TOOL_CALL" ? "TOOL" : s.span_type?.includes("LLM") ? "LLM" : "SPAN"}
                      </span>
                      <span className="truncate font-mono text-[12px] text-rp-ink">{s.name}</span>
                      <span className="rp-meta ml-auto flex-shrink-0">{fmt(s.duration_ms)}</span>
                    </div>
                    <ErrorMessage span={s} />
                  </div>
                ))}
              </div>
              {moreBelow && (
                <div data-errors-overflow-hint aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center pb-1.5"
                  style={{ height: 44, background: "linear-gradient(to bottom, color-mix(in srgb, var(--rp-surface) 0%, transparent), var(--rp-surface) 72%)" }}>
                  <span className="flex items-center gap-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink">
                    <ArrowDown size={10} strokeWidth={2.5} />Scroll for more
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

const Dot = () => <span data-separator aria-hidden="true" className="text-rp-ink-faint">&middot;</span>;

// A stat wraps together with the separator after it, so a wrap can only leave
// a separator at the end of a line, never at the start of the next one.
function Stat({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return <span className="inline-flex items-center gap-1.5">{children}{!last && <Dot />}</span>;
}

export function Badge({ label, copyValue }: { label: string; copyValue?: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetRef.current) window.clearTimeout(resetRef.current);
  }, []);

  if (!copyValue) {
    return (
      <span className="rp-meta-label font-mono text-11 font-medium uppercase leading-4 tracking-[0.08em]">
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={cn("rp-meta-label rp-meta-copy rounded-sm font-mono text-11 font-medium uppercase leading-4 tracking-[0.08em] transition-[color,background-color] duration-250 ease-standard", copied && "!bg-rp-success-soft !text-rp-success")}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(copyValue).then(() => {
          setCopied(true);
          if (resetRef.current) window.clearTimeout(resetRef.current);
          resetRef.current = window.setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
    >
      {label}
    </button>
  );
}

export type RunStats = { spans: number; tools: number; llms: number; errors: number; dur: number; agents?: number; inTokens?: number; outTokens?: number; llmCalls?: number; models?: string[]; tokenUnknownCalls?: number };

export function runStatsFor(spans: Span[], base: Omit<RunStats, "llmCalls" | "models" | "tokenUnknownCalls">): RunStats {
  const counted = countedLlmSpans(spans);
  return {
    ...base,
    llmCalls: counted.length,
    models: distinctModels(spans),
    tokenUnknownCalls: counted.filter(span => span.input_tokens == null || span.output_tokens == null).length,
  };
}

export function StatsLine({ stats, model, spans, active, startedAt, completionUnavailable, hideModels }: {
  hideModels?: boolean;
  stats: RunStats;
  model?: string | null;
  spans?: Span[];
  active?: boolean;
  startedAt?: number;
  completionUnavailable?: boolean;
}) {
  const [showCost, setShowCost] = useState(false);
  const costRef = useRef<HTMLSpanElement>(null);
  const costButtonRef = useRef<HTMLButtonElement>(null);
  const costPanelRef = useRef<HTMLDivElement>(null);
  const costPanelId = useId();
  const pricing = useSyncExternalStore(subscribePricing, getPricingSnapshot, getPricingSnapshot);
  const [costPosition, setCostPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const inTok = stats.inTokens ?? 0;
  const outTok = stats.outTokens ?? 0;

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active || completionUnavailable) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [active, completionUnavailable]);

  const breakdown = useMemo(() => spans ? getRunCostRows(spans, pricing) : [], [spans, pricing]);

  useLayoutEffect(() => {
    if (!showCost) return;
    const position = () => {
      const rect = costButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(352, window.innerWidth - 32);
      const height = Math.min(costPanelRef.current?.scrollHeight ?? 400, 400, window.innerHeight - 32);
      setCostPosition({ left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), top: rect.bottom + height + 8 <= window.innerHeight - 16 ? rect.bottom + 8 : Math.max(16, rect.top - height - 8), width });
    };
    position();
    // The first measurement runs before the panel width is constrained, so a
    // wrapped multi-model panel grows taller afterwards and must be re-placed.
    const observer = new ResizeObserver(position);
    if (costPanelRef.current) observer.observe(costPanelRef.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [showCost, breakdown]);

  useEffect(() => {
    if (!showCost) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !costRef.current?.contains(event.target)) setShowCost(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setShowCost(false); costButtonRef.current?.focus(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [showCost]);

  const ticking = !!(active && startedAt);
  const liveDur = active && startedAt ? now - startedAt : stats.dur;
  const durValid = Number.isFinite(liveDur) && liveDur >= 0;
  const durSec = Math.round(liveDur / 1000);
  const durMin = Math.floor(durSec / 60);
  const durRemSec = durSec % 60;
  const hasTokens = inTok > 0 || outTok > 0;
  const hasCost = breakdown.length > 0;
  const { knownUsd: totalCost, pricedCalls, unavailableCalls, allReported } = summarizeRunCost(breakdown);
  const availableTotal = pricedCalls > 0 && Number.isFinite(totalCost);
  const costLabel = !availableTotal ? "Estimate unavailable"
    : unavailableCalls ? `${allReported ? "Known reported cost" : "Known estimates"} ${fmtCost(totalCost)} · ${unavailableCalls} ${unavailableCalls === 1 ? "call" : "calls"} unavailable`
    : `${allReported ? "Reported cost" : "Estimated cost"} ${fmtCost(totalCost)}`;

  // Where the stats wrap, the separator after the last stat on a line has
  // nothing to separate; index.css hides it on the stat marked here.
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const markLineEnds = () => {
      const items = [...row.children];
      const boxes = items.map(item => item.getBoundingClientRect());
      items.forEach((item, index) => {
        const next = boxes[index + 1];
        item.toggleAttribute("data-line-end", !next || next.top >= boxes[index].bottom);
      });
    };
    markLineEnds();
    const observer = new ResizeObserver(markLineEnds);
    observer.observe(row);
    for (const item of row.children) observer.observe(item);
    return () => observer.disconnect();
  });

  const models = stats.models ?? (model ? [model] : []);
  const items: { key: string; node: ReactNode }[] = [];
  // NumberFlow animates whole seconds, which reads well for a clock ticking
  // on a run in flight. A settled duration is a measurement, though: rounded
  // to whole seconds it read "6s" beside a span tree root of "6.2s", "0s"
  // beside "420ms", and "205m" for a 3h run. Only the live tick animates;
  // everything else goes through fmt(), exactly like the span tree.
  if (models.length && !hideModels) items.push({ key: "model", node: <><Badge label={models.length > 1 ? "models" : "model"} copyValue={models.join(", ")} /><span className="max-w-[28ch] truncate" title={models.join(", ")}>{models.join(", ")}</span></> });
  items.push({ key: "duration", node: <><Badge label="duration" /><span data-run-duration>{
    completionUnavailable
      ? "Unavailable"
      : !durValid
      ? "—"
      : !ticking || liveDur < 1000 || liveDur >= 3_600_000
        ? fmt(liveDur)
        : durMin > 0
          ? <><NumberFlow value={durMin} />m <NumberFlow value={durRemSec} />s</>
          : <><NumberFlow value={durSec} />s</>
  }</span></> });
  if (stats.llmCalls) items.push({ key: "llm", node: <><Badge label="llm calls" /><span data-run-llm-calls><NumberFlow value={stats.llmCalls} /></span></> });
  if (stats.tools > 0) items.push({ key: "tools", node: <><Badge label="tools" /><span data-run-tool-calls><NumberFlow value={stats.tools} /></span></> });
  if ((stats.agents ?? 0) > 0) items.push({ key: "agents", node: <><Badge label="sub-agents" /><span><NumberFlow value={stats.agents!} /></span></> });
  if (stats.errors > 0) items.push({ key: "errors", node: spans
    ? <ErrorsTooltip spans={spans} />
    : <span className="font-medium text-rp-danger"><NumberFlow value={stats.errors} /> error{stats.errors !== 1 ? "s" : ""}</span> });
  if (hasTokens) items.push({ key: "tokens", node: <><Badge label="tokens" /><span><NumberFlow value={inTok} {...TOKEN_NUMBER_FLOW_TIMING} /> in / <NumberFlow value={outTok} {...TOKEN_NUMBER_FLOW_TIMING} /> out{stats.tokenUnknownCalls ? <span className="text-rp-ink-subtle" title="These calls did not report token counts, so the totals cover only the calls that did."> ({plural(stats.tokenUnknownCalls, "call")} unknown)</span> : null}</span></> });
  if (hasCost) items.push({ key: "cost", node: <>
          <span ref={costRef} className="relative">
            <button ref={costButtonRef} type="button" className="-my-3 min-h-11 min-w-11 rounded-control px-2 text-left text-rp-ink-muted underline decoration-rp-line-dashed decoration-dotted underline-offset-4 transition-colors duration-250 ease-standard hover:text-rp-blue" aria-expanded={showCost} aria-controls={costPanelId} onClick={() => setShowCost(open => !open)}>
              <span aria-live="polite">{costLabel}</span>
            </button>
            {showCost && (
              <div ref={costPanelRef} id={costPanelId} role="region" aria-label="Cost breakdown" className="fixed z-50 overflow-y-auto rounded-md border border-rp-line bg-rp-surface p-4 text-[12px] shadow-e3"
                style={{ ...costPosition, maxHeight: "min(400px, calc(100vh - 32px))", visibility: costPosition ? "visible" : "hidden" }}>
                <div className="rp-eyebrow mb-2">Cost by model</div>
                <p className="mb-3 whitespace-normal leading-5 text-rp-ink-muted">Reported costs are used as is. Estimates price input, output and cached input at list prices as of {PRICE_TABLE_AS_OF}, or input and output at OpenRouter catalogue quotes; fees excluded.</p>
                {breakdown.map(b => (
                  <div key={b.model === null ? "missing-model" : `model:${b.model}`} className="mb-3 last:mb-0 whitespace-normal break-words">
                    <div className="mb-1 font-mono text-[12px] font-medium text-rp-ink">{b.model ?? "Model unavailable"}</div>
                    <CostRowDetail row={b} />
                  </div>
                ))}
              </div>
            )}
          </span>
        </> });

  return (
    <div ref={rowRef} className="rp-meta-metrics flex flex-wrap items-center gap-x-2 gap-y-1 text-12 text-rp-ink">
      {items.map((item, index) => <Stat key={item.key} last={index === items.length - 1}>{item.node}</Stat>)}
    </div>
  );
}

function CostLine({ label, amount, strong = false }: { label: ReactNode; amount: number; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-4", strong && "border-t border-rp-line pt-1")}>
      <span className={cn(strong && "text-rp-ink")}>{label}</span>
      <span className={cn("rp-num text-rp-ink", strong && "font-medium")}>{fmtCost(amount)}</span>
    </div>
  );
}

function CostRowDetail({ row }: { row: ModelCostRow }) {
  const { sources } = row;
  const used = [sources.reported, sources.listPrice, sources.catalogue].filter(count => count > 0).length;
  // Per-token lines only when one source priced every call; calls in different price bands would make one rate untrue.
  const tokens = used === 1 && row.totalUsd !== null && row.inTok !== null && row.outTok !== null;
  return (
    <div className="space-y-1 text-rp-ink-muted">
      {sources.reported > 0 && <CostLine label="Reported on the span" amount={row.reportedUsd} />}
      {row.listPrice && <>
        {tokens && Math.abs(row.inTok! * row.listPrice.inRate / 1_000_000 + row.outTok! * row.listPrice.outRate / 1_000_000 + row.listPriceCacheUsd - row.listPriceUsd) <= 1e-9 * Math.max(1, row.listPriceUsd) && <>
          <CostLine label={`${row.inTok!.toLocaleString()} input @ ${fmtRate(row.listPrice.inRate)}/M`} amount={row.inTok! * row.listPrice.inRate / 1_000_000} />
          <CostLine label={`${row.outTok!.toLocaleString()} output @ ${fmtRate(row.listPrice.outRate)}/M`} amount={row.outTok! * row.listPrice.outRate / 1_000_000} />
        </>}
        {row.listPriceCacheTokens > 0 && <CostLine label={`${row.listPriceCacheTokens.toLocaleString()} cached input tokens`} amount={row.listPriceCacheUsd} />}
        <CostLine label="Estimated at list price" amount={row.listPriceUsd} strong={tokens || row.listPriceCacheTokens > 0} />
        <p>Price for {row.listPrice.priceModel} from <a className="text-rp-blue underline underline-offset-4 hover:text-rp-blue-hover" href={row.listPrice.sourceUrl} target="_blank" rel="noreferrer">{row.listPrice.sourceName}</a>, as of {row.listPrice.asOf}.</p>
      </>}
      {row.catalogue && <>
        {tokens && <>
          <CostLine label={`${row.inTok!.toLocaleString()} input @ ${fmtRate(row.catalogue.inRate)}/M`} amount={row.catalogue.inCost} />
          <CostLine label={`${row.outTok!.toLocaleString()} output @ ${fmtRate(row.catalogue.outRate)}/M`} amount={row.catalogue.outCost} />
        </>}
        <CostLine label="Estimated from the OpenRouter catalogue" amount={row.catalogueUsd} strong={tokens} />
        <div>Catalogue ID: {row.catalogue.catalogueId}</div>
        <div>Revision: <span className="font-mono">{row.catalogue.rateRevision}</span></div>
        <div>Fetched: {row.catalogue.source.observedAt}</div>
      </>}
      {used > 1 && row.totalUsd !== null && <CostLine label="total" amount={row.totalUsd} strong />}
      {row.unavailableReason && <p>{used > 0 ? `${row.unavailableCalls} of ${row.generations} calls ${row.unavailableCalls === 1 ? "is" : "are"} unpriced. ` : ""}{row.unavailableReason}</p>}
    </div>
  );
}

