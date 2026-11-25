import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ClockArrowUp, Play, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/typography";
import {
  getDraftFromSpan, getPlaygroundModels, recordedColumn, streamPlaygroundRun, type PlaygroundProviderInfo,
} from "../api/playground";
import type { RunSearchRun } from "../api/runs";
import { effectiveMaxTemperature, ModelPicker, modelLabel, PlaygroundEditor } from "../components/playground/PlaygroundEditor";
import { ResultColumn, type ColumnState } from "../components/playground/PlaygroundOutput";
import { PLAYGROUND_HISTORY_KEY, PlaygroundHistory } from "../components/playground/PlaygroundHistory";
import {
  appendToolRound, buildRunBody, loadDraft, MAX_COMPARE_COLUMNS, saveDraft, stateFromDraft,
  type BuildResult, type PlaygroundDraftState, type PlaygroundTarget,
} from "../components/playground/playground-model";
import { useRegisterShortcuts } from "../shell/commands";
import { ariaKeyShortcuts, formatKeys, isMacPlatform } from "../shell/keyboard";

const RUN_KEYS = "mod+enter";

function nextTarget(existing: readonly PlaygroundTarget[], providers: readonly PlaygroundProviderInfo[] | undefined): PlaygroundTarget {
  const used = new Set(existing.map(target => `${target.provider}/${target.model}`));
  const ordered = [...(providers ?? [])].sort((a, b) => Number(b.configured) - Number(a.configured));
  for (const provider of ordered) {
    const candidate = { provider: provider.id, model: provider.defaultModel };
    if (!used.has(`${candidate.provider}/${candidate.model}`)) return candidate;
  }
  for (const provider of ordered) for (const model of provider.models) {
    if (!used.has(`${provider.id}/${model.id}`)) return { provider: provider.id, model: model.id };
  }
  return existing[0] ?? { provider: "openai", model: "gpt-5-nano" };
}

const BUILD_FIELD_SELECTOR: Record<Exclude<BuildResult, { ok: true }>["field"], string> = {
  messages: "[data-playground-message] textarea",
  temperature: "[data-playground-field='temperature']",
  maxOutputTokens: "[data-playground-field='maxOutputTokens']",
  tools: "[data-playground-field='tools']",
  targets: "#playground-model-0",
};

function focusProblem(built: Exclude<BuildResult, { ok: true }>) {
  window.requestAnimationFrame(() => {
    const selector = built.field === "messages" && built.index !== undefined
      ? `[data-playground-message='${built.index}'] textarea`
      : BUILD_FIELD_SELECTOR[built.field];
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
  });
}

function resize<T>(items: readonly T[], length: number, make: (index: number) => T): T[] {
  return Array.from({ length }, (_, index) => items[index] ?? make(index));
}

export function PlaygroundPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const models = useQuery({ queryKey: ["playground", "models"], queryFn: ({ signal }) => getPlaygroundModels(signal), staleTime: 30_000 });
  const providers = models.data?.providers;
  const providersRef = useRef(providers);
  providersRef.current = providers;

  const [draft, setDraft] = useState<PlaygroundDraftState>(() => loadDraft());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [columns, setColumns] = useState<ColumnState[]>(() => draft.targets.map(() => ({ status: "idle" })));
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<{ message: string; field: string | null } | null>(null);
  const [diff, setDiff] = useState(false);
  const [formatted, setFormatted] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [opening, setOpening] = useState<{ status: "loading" } | { status: "error"; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => saveDraft(draft), 250);
    return () => window.clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const flush = () => saveDraft(draftRef.current);
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); abortRef.current?.abort(); };
  }, []);

  const update = useCallback((change: (draft: PlaygroundDraftState) => PlaygroundDraftState) => {
    setDraft(change);
    setProblem(current => current?.field ? null : current);
  }, []);

  const spanParam = searchParams.get("span");
  const runParam = searchParams.get("run");
  useEffect(() => {
    if (!spanParam) return;
    const controller = new AbortController();
    setOpening({ status: "loading" });
    getDraftFromSpan(spanParam, runParam, controller.signal).then(result => {
      setDraft(current => stateFromDraft(result, current, { openedFrom: true }));
      setColumns([{ status: "idle" }]);
      setDiff(false);
      setOpening(null);
      navigate("/playground", { replace: true });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setOpening({ status: "error", message: error instanceof Error ? error.message : "This step could not be opened." });
      navigate("/playground", { replace: true });
    });
    return () => controller.abort();
  }, [navigate, runParam, spanParam]);

  const setTargets = useCallback((targets: PlaygroundTarget[]) => {
    const before = draftRef.current.targets;
    setDraft(current => ({ ...current, targets }));
    setColumns(current => resize<ColumnState>(current, targets.length, () => ({ status: "idle" })).map((column, index): ColumnState => {
      const previous = before[index];
      const next = targets[index]!;
      return previous && previous.provider === next.provider && previous.model === next.model ? column : { status: "idle" };
    }));
  }, []);

  const setCompareCount = (count: number) => {
    const current = draftRef.current.targets;
    if (count === current.length) return;
    const targets = count < current.length ? current.slice(0, count) : [...current];
    while (targets.length < count) targets.push(nextTarget(targets, providers));
    setTargets(targets);
    if (count < 2) setDiff(false);
  };

  const run = useCallback(async () => {
    if (abortRef.current) return;
    const built: BuildResult = buildRunBody(draftRef.current, { maxTemperature: effectiveMaxTemperature(providersRef.current, draftRef.current.targets) });
    if (!built.ok) {
      setProblem({ message: built.error, field: built.field });
      setAnnouncement(built.error);
      focusProblem(built);
      return;
    }
    setProblem(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    const count = built.body.targets.length;
    const texts = built.body.targets.map(() => "");
    setColumns(built.body.targets.map(() => ({ status: "running", text: "", startedAt })));
    setRunning(true);
    setAnnouncement(count === 1 ? "Running 1 model." : `Running ${count} models.`);
    // Below the lg breakpoint the output stacks under the editor, out of view.
    if (window.matchMedia("(max-width: 1023px)").matches) outputRef.current?.scrollIntoView({ block: "start" });
    let ok = 0, failed = 0;
    try {
      await streamPlaygroundRun(built.body, event => {
        if (event.type === "delta") {
          texts[event.index] = (texts[event.index] ?? "") + event.text;
          const text = texts[event.index]!;
          setColumns(current => current.map((column, index) => index === event.index && column.status === "running" ? { ...column, text } : column));
        } else if (event.type === "result") {
          const result = event.result;
          if (result.status === "ok") ok++; else failed++;
          setColumns(current => current.map((column, index) => index === result.index ? { status: "done", result, text: result.output.text } : column));
        } else if (event.type === "error") {
          setProblem({ message: event.error, field: null });
        }
      }, controller.signal);
      setAnnouncement(failed ? `Finished. ${ok} succeeded, ${failed} failed.` : count === 1 ? "Finished." : `Finished. All ${count} models answered.`);
    } catch (error) {
      const stopped = controller.signal.aborted;
      const message = stopped ? "Stopped. Calls that had started are recorded as cancelled runs." : error instanceof Error ? error.message : "The Playground request failed.";
      if (!stopped) setProblem({ message, field: null });
      setAnnouncement(stopped ? "Stopped." : message);
      setColumns(current => current.map(column => column.status === "running" ? { status: "stopped", text: column.text, note: stopped ? "Stopped before the model finished." : "No result was received." } : column));
    } finally {
      abortRef.current = null;
      setRunning(false);
      void queryClient.invalidateQueries({ queryKey: PLAYGROUND_HISTORY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    }
  }, [queryClient]);

  const stop = () => abortRef.current?.abort();

  useRegisterShortcuts([
    { id: "playground:run", keys: RUN_KEYS, scope: "Playground", description: "Run the prompt", allowInInputs: true, handler: event => { event.preventDefault(); void run(); } },
  ], [run]);

  const loadFromHistory = async (runs: RunSearchRun[]) => {
    const loaded = await Promise.all(runs.map(async item => {
      const column = await recordedColumn(item.id);
      if (!column.spanId) throw new Error("This run has no model call to load.");
      return { order: column.index ?? Number.MAX_SAFE_INTEGER, draft: await getDraftFromSpan(column.spanId, item.id) };
    }));
    const drafts = loaded.map((item, position) => ({ ...item, position })).sort((a, b) => a.order - b.order || a.position - b.position).map(item => item.draft);
    const first = drafts[0];
    if (!first) return;
    const targets = drafts.map(item => ({ provider: item.provider, model: item.model }));
    setDraft(current => stateFromDraft(first, current, { openedFrom: false, targets }));
    setColumns(targets.map(() => ({ status: "idle" })));
    setDiff(false);
    setProblem(null);
  };

  const doneTexts = columns.map(column => column.status === "done" ? column.text : null);
  const canDiff = draft.targets.length > 1 && !!doneTexts[0] && doneTexts.slice(1).some(text => !!text);
  const opened = draft.openedFrom;

  return (
    <div className="rp-page flex min-h-full flex-col lg:h-full lg:min-h-0 lg:pb-5">
      <PageHeader
        eyebrow="Playground / Recorded as runs"
        title="Playground"
        actions={(
          <>
            <div role="group" aria-label="Models to compare" className="flex items-center gap-2">
              <span className="text-[12px] text-rp-ink-muted" aria-hidden="true">Compare</span>
              <div className="flex rounded-control border border-rp-line bg-rp-surface p-0.5">
                {Array.from({ length: MAX_COMPARE_COLUMNS }, (_, index) => index + 1).map(count => (
                  <button
                    key={count}
                    type="button"
                    aria-pressed={draft.targets.length === count}
                    aria-label={count === 1 ? "1 model" : `${count} models`}
                    disabled={running}
                    onClick={() => setCompareCount(count)}
                    className={cn(
                      "h-7 min-w-8 rounded-[2px] px-2 font-mono text-[12px] tabular-nums transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue disabled:opacity-50",
                      draft.targets.length === count ? "bg-rp-blue text-rp-on-solid" : "text-rp-ink-soft hover:bg-rp-row-hover",
                    )}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <ClockArrowUp aria-hidden="true" /> History
            </Button>
          </>
        )}
      />

      {opening?.status === "loading" && <p role="status" className="mt-3 text-[13px] text-rp-ink-muted">Opening the step in the Playground…</p>}
      {opening?.status === "error" && (
        <div role="alert" className="mt-3 flex items-start justify-between gap-3 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-[13px] text-rp-danger">
          <span>Could not open that step: {opening.message}</span>
          <button type="button" onClick={() => setOpening(null)} aria-label="Dismiss" className="shrink-0 rounded-control p-0.5 hover:bg-rp-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue"><X aria-hidden="true" className="size-4" /></button>
        </div>
      )}

      <div className={cn("mt-4 grid min-h-0 flex-1 gap-4", draft.targets.length === 3 ? "lg:grid-cols-[minmax(340px,4fr)_8fr]" : "lg:grid-cols-[minmax(360px,5fr)_7fr]")}>
        <section aria-label="Prompt" className="flex min-h-0 flex-col rounded-md border border-rp-line bg-rp-surface">
          <div className="sb min-h-0 flex-1 space-y-5 overflow-auto p-4">
            {opened && (
              <div className="rounded-sm border border-rp-wash-border bg-rp-wash px-3 py-2" data-playground-opened-from>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-[13px] leading-5 text-rp-ink">
                    <span className="text-rp-ink-muted">Opened from </span>
                    <Link to={`/runs/${opened.runId}/span/${opened.spanId}`} className="font-medium text-rp-blue underline-offset-2 hover:underline">
                      {opened.runName ?? opened.runId.slice(0, 8)} › {opened.spanName}
                    </Link>
                    <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3.5 text-rp-blue" />
                  </p>
                  <button
                    type="button"
                    onClick={() => update(current => ({ ...current, openedFrom: null }))}
                    aria-label="Detach from the captured step"
                    title="Runs will no longer link back to the captured step."
                    className="shrink-0 rounded-control p-0.5 text-rp-ink-muted hover:bg-rp-surface hover:text-rp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue"
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                </div>
                {opened.warnings.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {opened.warnings.map(warning => <li key={warning} className="text-[12px] leading-[18px] text-rp-ink-soft">{warning}</li>)}
                  </ul>
                )}
              </div>
            )}

            <section aria-label="Models" className={cn("grid gap-3", draft.targets.length === 2 && "sm:grid-cols-2")}>
              {draft.targets.map((target, index) => (
                <ModelPicker
                  key={index}
                  id={`playground-model-${index}`}
                  label={draft.targets.length === 1 ? "Model" : `Model ${index + 1}`}
                  target={target}
                  providers={providers}
                  disabled={running}
                  onChange={next => setTargets(draft.targets.map((item, position) => position === index ? next : item))}
                  onRemove={draft.targets.length > 1 && !running ? () => setTargets(draft.targets.filter((_, position) => position !== index)) : undefined}
                />
              ))}
            </section>
            {models.isError && (
              <p role="alert" className="text-[13px] text-rp-danger">The model list could not be loaded: {models.error instanceof Error ? models.error.message : "unknown error"}.</p>
            )}

            <PlaygroundEditor draft={draft} update={update} providers={providers} invalidField={problem?.field ?? null} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rp-line px-4 py-3">
            <p className={cn("min-w-0 flex-1 text-[12px] leading-[18px]", problem ? "text-rp-danger" : "text-rp-ink-muted")} role={problem ? "alert" : undefined} data-playground-problem={problem ? "" : undefined}>
              {problem ? problem.message : "Each call is recorded as a run."}
            </p>
            {running ? (
              <Button variant="outline" onClick={stop}>
                <Square aria-hidden="true" /> Stop
              </Button>
            ) : (
              <Button onClick={() => void run()} aria-keyshortcuts={ariaKeyShortcuts(RUN_KEYS)}>
                <Play aria-hidden="true" /> {draft.targets.length > 1 ? `Run ${draft.targets.length} models` : "Run"}
                <kbd aria-hidden="true" className="ml-1 hidden rounded-[2px] sm:inline [@media(pointer:coarse)]:hidden border border-white/40 px-1 font-mono text-[11px] font-normal leading-4 text-rp-on-solid">{formatKeys(RUN_KEYS, isMacPlatform())}</kbd>
              </Button>
            )}
          </div>
        </section>

        <section ref={outputRef} aria-label="Output" className="flex min-h-0 scroll-mt-4 flex-col">
          <div className="flex items-center justify-between gap-3 pb-2">
            <h2 className="rp-eyebrow">Output</h2>
            <div className="flex items-center gap-2">
              <div role="group" aria-label="Output text" className="flex rounded-control border border-rp-line bg-rp-surface p-0.5">
                {([["Formatted", true], ["Raw", false]] as const).map(([label, value]) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={formatted === value}
                    onClick={() => setFormatted(value)}
                    className={cn(
                      "h-6 rounded-[2px] px-2 text-[12px] font-medium transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue",
                      formatted === value ? "bg-rp-wash text-rp-blue" : "text-rp-ink-soft hover:bg-rp-row-hover",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {draft.targets.length > 1 && (
                <button
                  type="button"
                  aria-pressed={diff && canDiff}
                  disabled={!canDiff}
                  onClick={() => setDiff(value => !value)}
                  title={canDiff ? "Highlight words that differ from column 1" : "Run at least two models with text output to compare them"}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-[12px] font-medium transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue disabled:cursor-not-allowed disabled:opacity-50",
                    diff && canDiff ? "border-rp-wash-border bg-rp-wash text-rp-blue" : "border-rp-line bg-rp-surface text-rp-ink-soft hover:bg-rp-row-hover",
                  )}
                >
                  Show differences
                </button>
              )}
            </div>
          </div>
          <div className={cn("grid min-h-0 flex-1 gap-3", draft.targets.length === 2 && "md:grid-cols-2", draft.targets.length === 3 && "md:grid-cols-3")}>
            {draft.targets.map((target, index) => {
              const column = columns[index] ?? { status: "idle" };
              const title = column.status === "done" ? modelLabel(providers, { provider: column.result.provider, model: column.result.model }) : modelLabel(providers, target);
              return (
                <ResultColumn
                  key={index}
                  index={index}
                  title={title}
                  subtitle={providers?.find(item => item.id === target.provider)?.label ?? target.provider}
                  state={column}
                  formatted={formatted}
                  diffBase={diff && canDiff && index > 0 ? doneTexts[0] ?? null : null}
                  onAddToolRound={column.status === "done" && column.result.output.toolCalls.length && !running
                    ? () => {
                      update(current => appendToolRound(current, column.result));
                      setAnnouncement("Added the tool calls to the conversation. Fill in each tool result, then run again.");
                    }
                    : undefined}
                />
              );
            })}
          </div>
        </section>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <PlaygroundHistory open={historyOpen} onOpenChange={setHistoryOpen} onLoad={loadFromHistory} />
    </div>
  );
}
