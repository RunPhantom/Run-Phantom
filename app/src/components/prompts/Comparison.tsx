import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Download, RefreshCw, Square, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useDialogFocus } from "../../hooks/use-dialog-focus";
import type { PromptClient, PromptRevision } from "./client";
import { comparisonCapabilities, comparisonPage, comparisonReceipt, comparisonRequest, comparisonOutput, comparisonExport,
  type ComparisonCapabilities, type ComparisonPage, type ComparisonReceipt } from "./comparison-client";
import "./comparison.css";
import { ComparisonBreadcrumb } from "./ComparisonBreadcrumb";
import { ComparisonAccounting } from "./ComparisonAccounting";

interface View { key: string; capabilities: ComparisonCapabilities; page: ComparisonPage; selected: ComparisonReceipt | null }
const pending = (receipt: ComparisonReceipt | null) => !!receipt?.attempts.some(attempt => ["queued", "running"].includes(attempt.status));
const usd = (microusd: number) => `$${(microusd / 1000000).toFixed(6)}`;
const reasons: Record<string, string> = { credentials_unavailable: "Provider access is not configured.", budget_not_configured: "A spending budget is not configured for this server.", overage_fuse: "Observed usage exceeded its reservation. New spending is blocked.", ceiling_reached: "The admitted server budget is fully held or charged." };
export function Comparison({ client, source, variables, canEdit, canDelete, scopeLabel }: {
  client: PromptClient; source: PromptRevision | null; variables: Record<string, string>; canEdit: boolean; canDelete: boolean; scopeLabel: string;
}) {
  const key = `${scopeLabel}:${source?.id ?? "history"}:${source?.revision ?? 0}:${source?.templateSha256 ?? ""}`;
  const [view, setView] = useState<View | null>(null), [chosen, setChosen] = useState<string[]>([]);
  const [outputTokens, setOutputTokens] = useState("128"), [temperature, setTemperature] = useState("0"), [budget, setBudget] = useState("1");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirm, setConfirm] = useState<"run" | "clear" | null>(null), [unresolved, setUnresolved] = useState(false);
  const epoch = useRef<{ key: string; controller: AbortController } | null>(null), working = useRef(false), dialog = useRef<HTMLDivElement>(null), selection = useRef(0);
  const retry = useRef<Record<string, unknown> | null>(null);
  const current = view?.key === key ? view : null;
  useDialogFocus(confirm !== null, dialog, () => setConfirm(null));
  const request = useCallback(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const active = epoch.current; if (!active || active.key !== key) throw new DOMException("Selection changed", "AbortError");
    const value = await comparisonRequest(client, active.controller.signal)(path, options);
    if (epoch.current !== active) throw new DOMException("Selection changed", "AbortError"); return value;
  }, [client, key]);
  const perform = useCallback(async (work: () => Promise<void>) => {
    if (working.current) return; const active = epoch.current; if (!active || active.key !== key) return;
    working.current = true; setBusy(true); setError("");
    try { await work(); }
    catch (cause) {
      if (epoch.current === active && !active.controller.signal.aborted && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "Comparison request failed.");
        if (cause && typeof cause === "object" && "status" in cause && [401, 403].includes(Number(cause.status))) setView(null);
      }
    } finally { if (epoch.current === active) { working.current = false; setBusy(false); } }
  }, [key]);
  const refresh = useCallback(async () => {
    const capabilities = comparisonCapabilities(await request("/capabilities")), page = comparisonPage(await request(""));
    setView(previous => ({ key, capabilities, page, selected: previous?.key === key ? previous.selected : null }));
  }, [key, request]);
  useEffect(() => {
    const active = { key, controller: new AbortController() }; epoch.current = active; working.current = false;
    setView(null); setChosen([]); setError(""); setBusy(false); setUnresolved(false); setConfirm(null); retry.current = null; selection.current++;
    void perform(refresh);
    return () => { active.controller.abort(); if (epoch.current === active) epoch.current = null; };
  }, [client, key, perform, refresh]);
  const selectedId = current?.selected?.id, isPending = pending(current?.selected ?? null);
  useEffect(() => {
    if (!selectedId || !isPending) return;
    const active = epoch.current, ticket = selection.current; let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const receipt = comparisonReceipt(await request(`/${selectedId}`));
        if (stopped || epoch.current !== active || ticket !== selection.current) return;
        if (pending(receipt)) {
          setView(previous => previous?.key === key && previous.selected?.id === selectedId ? { ...previous, selected: receipt } : previous);
          timer = setTimeout(() => void read(), 1000);
        } else {
          const capabilities = comparisonCapabilities(await request("/capabilities"));
          const page = comparisonPage(await request(""));
          if (!stopped && epoch.current === active && ticket === selection.current) setView(previous => previous?.key === key && previous.selected?.id === selectedId ? { ...previous, selected: receipt, capabilities, page } : previous);
        }
      } catch (cause) {
        if (!stopped && epoch.current === active && !active?.controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Current results could not be refreshed. The operation remains saved.");
      }
    };
    timer = setTimeout(() => void read(), 1000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [selectedId, isPending, key, request]);
  async function load(id: string) {
    const ticket = ++selection.current, value = comparisonReceipt(await request(`/${id}`));
    if (ticket !== selection.current || value.id !== id) return;
    setView(previous => previous?.key === key ? { ...previous, selected: value } : previous);
  }
  async function run() {
    if (!current || !source || !canEdit) return;
    const body = retry.current ?? { operationKey: crypto.randomUUID(), promptId: source.id, revision: source.revision,
      variables: Object.fromEntries(source.variableNames.map(name => [name, variables[name] ?? ""])),
      targets: current.capabilities.models.filter(model => chosen.includes(`${model.provider}:${model.model}`)).map(({ provider, model }) => ({ provider, model })),
      options: { maxOutputTokens: Number(outputTokens), temperature: Number(temperature) }, operationBudgetMicrousd: Math.round(Number(budget) * 1000000), expectedGeneration: current.capabilities.generation };
    retry.current = body;
    try {
      const result = comparisonReceipt(await request("", { method: "POST", body: { ...body, expectedGeneration: current.capabilities.generation } }));
      if (result.request && (result.request.promptId !== source.id || result.request.revision !== source.revision || result.request.prompt.templateSha256 !== source.templateSha256)) throw new Error("The comparison does not match this saved source.");
      selection.current++; setView(previous => previous?.key === key ? { ...previous, selected: result } : previous); retry.current = null; setUnresolved(false); await refresh();
    } catch (cause) {
      const rejected = cause && typeof cause === "object" && "status" in cause && Number(cause.status) >= 400 && Number(cause.status) < 500;
      if (rejected) retry.current = null; else setUnresolved(true); throw cause;
    }
  }
  const selectedModels = current?.capabilities.models.filter(model => chosen.includes(`${model.provider}:${model.model}`)) ?? [];
  const settingsValid = /^[1-9][0-9]*$/.test(outputTokens) && Number(outputTokens) <= 1024 && /^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(temperature) && Number.isFinite(Number(temperature)) && Number(temperature) >= 0 && Number(temperature) <= 1
    && /^(?:0|1)(?:\.[0-9]{1,6})?$/.test(budget) && Number(budget) > 0 && Number(budget) <= 1;
  const runnable = !!source && canEdit && !busy && !!current && selectedModels.length > 0 && selectedModels.every(model => model.spendingEnabled) && settingsValid;
  async function clear() {
    if (!current) return;
    await request("/clear", { method: "POST", body: { operationKey: crypto.randomUUID(), expectedGeneration: current.capabilities.generation, confirmRemoval: true } });
    selection.current++; setView(previous => previous?.key === key ? { ...previous, selected: null } : previous); await refresh();
  }
  async function exportResult() {
    if (!current?.selected) return; const value = comparisonExport(await request(`/${current.selected.id}/export`), current.selected.id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    try { const anchor = document.createElement("a"); anchor.href = url; anchor.download = `comparison-${current.selected.id}.json`; anchor.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  return <section className="comparison-workspace" aria-labelledby="comparison-title" data-testid="comparison-workspace">
    <header className="comparison-heading"><div><ComparisonBreadcrumb scopeLabel={scopeLabel} revision={source?.revision ?? null} /><h2 id="comparison-title">Compare models</h2><p>Compare a saved prompt across selected models. Each result keeps its output, observed usage and accounting record.</p></div><Button size="lg" variant="outline" disabled={busy} onClick={() => void perform(refresh)}><RefreshCw />Refresh comparisons</Button></header>
    {error && <p role="alert" className="comparison-error">{error}</p>}
    {!current && <p className="prompt-muted">{busy ? "Loading current comparison access…" : "Model comparisons are unavailable for this native owner."}</p>}
    {current && <div className="comparison-layout"><div className="comparison-settings">
      <p className="comparison-source">{source ? `Saved revision ${source.revision} · ${source.name}` : "Select a saved prompt revision to compare it."}<span>Unsaved template changes are excluded.</span></p>
      <fieldset disabled={!canEdit || busy || unresolved}><legend>Models <span>Choose up to four</span></legend><div className="comparison-models">{current.capabilities.models.map(model => {
        const modelKey = `${model.provider}:${model.model}`;
        return <label key={modelKey} className={chosen.includes(modelKey) ? "comparison-model chosen" : "comparison-model"}><input type="checkbox" checked={chosen.includes(modelKey)} onChange={() => setChosen(previous => previous.includes(modelKey) ? previous.filter(value => value !== modelKey) : [...previous, modelKey])} /><span><strong>{model.model}</strong><small>{model.provider} · standard text</small><small>Reservation ceiling {usd(model.reservationCeilingMicrousd)} at maximum input/output</small>{model.admissionReason && <small className="comparison-access">{reasons[model.admissionReason]}</small>}</span></label>;
      })}</div></fieldset>
      <div className="comparison-options"><label>Maximum output tokens<Input inputMode="numeric" value={outputTokens} onChange={event => setOutputTokens(event.target.value)} disabled={!canEdit || busy || unresolved} /><small>1–1,024 tokens per target</small></label><label>Temperature<Input inputMode="decimal" value={temperature} onChange={event => setTemperature(event.target.value)} disabled={!canEdit || busy || unresolved} /><small>0–1, standard text settings</small></label><label>Operation budget (USD)<Input inputMode="decimal" value={budget} onChange={event => setBudget(event.target.value)} disabled={!canEdit || busy || unresolved} /><small>Positive cap, maximum $1</small></label></div>
      <p className="prompt-muted">Reservations bound this operation. Estimates use frozen standard text rates; provider invoices and account balances are unavailable. No request is sent until you confirm Run.</p>
      {unresolved && <p role="status" className="comparison-error">The request outcome is unavailable. Retry the same saved request to retrieve its receipt before starting another comparison.</p>}
      <Button size="lg" disabled={unresolved ? busy || !current : !runnable} onClick={() => unresolved ? void perform(run) : setConfirm("run")}><ArrowRight />{unresolved ? "Retry saved comparison" : "Run comparison"}</Button>
    </div><aside className="comparison-history" aria-label="Comparison history"><h3>Saved comparisons <span>{current.page.items.length}</span></h3>
      {!current.page.items.length && <p className="prompt-muted">Your first confirmed comparison will appear here.</p>}
      <ul>{current.page.items.map(item => <li key={item.id}><button type="button" aria-pressed={current.selected?.id === item.id} disabled={busy || unresolved} onClick={() => void perform(() => load(item.id))}><strong>{item.prompt?.name ?? "Content removed"}</strong><span>{item.prompt ? `Revision ${item.prompt.revision}` : "Accounting receipt retained"} · {item.attempts.length} targets</span><small>{item.attempts.map(attempt => attempt.status.replace(/_/g, " ")).join(" / ")}</small></button></li>)}</ul>
      {current.page.cursor && <Button size="lg" variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = comparisonPage(await request(`?${new URLSearchParams({ cursor: current.page.cursor! })}`)); setView(previous => previous?.key === key ? { ...previous, page: { ...page, items: [...previous.page.items, ...page.items.filter(item => !previous.page.items.some(old => old.id === item.id))].slice(0, 100) } } : previous); })}>Load more comparisons</Button>}
      {canDelete && <Button size="lg" variant="outline" disabled={busy || unresolved} onClick={() => setConfirm("clear")}><Trash2 />Clear comparison content</Button>}
    </aside></div>}
    {current?.selected && <section className="comparison-results" aria-label="Comparison results"><header><div><h3>{current.selected.request ? `${current.selected.request.prompt.name} · revision ${current.selected.request.revision}` : "Comparison content removed"}</h3><code>Operation {current.selected.id}</code></div><div className="prompt-actions"><Button size="lg" variant="outline" disabled={busy} onClick={() => void perform(exportResult)}><Download />Export comparison</Button>{canEdit && pending(current.selected) && <Button size="lg" variant="outline" disabled={busy} onClick={() => void perform(async () => { const result = comparisonReceipt(await request(`/${current.selected!.id}/cancel`, { method: "POST", body: { expectedGeneration: current.capabilities.generation } })); setView(previous => previous?.key === key ? { ...previous, selected: result } : previous); await refresh(); })}><Square />Cancel comparison</Button>}</div></header>
      {current.selected.request && <details className="comparison-frozen"><summary>Frozen input and settings</summary><p>SHA-256 {current.selected.request.prompt.templateSha256}</p><p>{current.selected.request.options.maxOutputTokens} output tokens · temperature {current.selected.request.options.temperature} · operation cap {usd(current.selected.request.operationBudgetMicrousd)}</p><p>Frozen rates: {current.selected.request.rates.map(rate => rate.revision).join(" / ")}</p><pre>{current.selected.request.compiled}</pre></details>}
      <div className="comparison-targets">{current.selected.attempts.map(attempt => {
        const output = comparisonOutput(attempt);
        return <article className="comparison-target" key={attempt.position} aria-label={`Result ${attempt.model}`}><header><h4>{attempt.model}</h4><span className="comparison-state">{attempt.status.replace(/_/g, " ")}</span></header>{attempt.reason && <p className="prompt-muted">Reason: {attempt.reason.replace(/_/g, " ")}</p>}{output.controlled && <p className="comparison-fixture">Controlled HTTP fixture · no paid provider call</p>}{attempt.budgetBreach && <p className="comparison-error">Observed usage breached its reservation. Further spending by this provider is blocked.</p>}
          {output.output !== null ? <pre data-testid={`comparison-output-${attempt.position}`}>{output.output}</pre> : <p className="prompt-muted">{["queued", "running"].includes(attempt.status) ? "Waiting for a retained result…" : "No output was retained for this target."}</p>}
          <ComparisonAccounting attempt={attempt} input={output.input} output={output.outputTokens} rateRevision={current.selected?.request?.rates[attempt.position].revision ?? null} />
        </article>;
      })}</div>
    </section>}
    {confirm && <div className="prompt-dialog-shade"><div ref={dialog} className="prompt-dialog" role="alertdialog" aria-modal="true" aria-labelledby="comparison-confirm-title" aria-describedby="comparison-confirm-description"><h2 id="comparison-confirm-title">{confirm === "run" ? "Send this saved revision?" : "Clear comparison input and output?"}</h2><p id="comparison-confirm-description">{confirm === "run" ? `Send revision ${source?.revision} with its current literal variables to ${selectedModels.length} selected providers. The operation cap is $${budget}. Unsaved editor changes are excluded.` : "This permanently removes comparison input and output in this scope. Spend, idempotency receipts and lifetime capacity remain. Saved prompts and captured reports remain available. This cannot be undone."}</p><div className="prompt-actions"><Button size="lg" variant="outline" onClick={() => setConfirm(null)}>Keep working</Button><Button size="lg" onClick={() => { const action = confirm; setConfirm(null); void perform(action === "run" ? run : clear); }}>{confirm === "run" ? "Confirm run comparison" : "Permanently clear comparisons"}</Button></div></div></div>}
  </section>;
}
