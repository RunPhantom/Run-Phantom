import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { FileCode2, History, Plus, Download, Trash2, CheckCircle2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useDialogFocus } from "../../hooks/use-dialog-focus";
import type { PromptClient, PromptCapabilities, PromptRevision, PromptSummary, PromptHistoryEntry, PromptPage, PromptCompilation, PromptExport } from "./client";
import "./prompt-workspace.css";

type Confirmation = { title: string; message: string; action: () => void; destructive?: boolean };
export function PromptWorkspace({ client, canEdit, canDelete, scopeLabel }: { client: PromptClient; canEdit: boolean; canDelete: boolean; scopeLabel: string }) {
  const [capabilities, setCapabilities] = useState<PromptCapabilities | null>(null), [items, setItems] = useState<PromptSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [source, setSource] = useState<PromptRevision | null>(null), [history, setHistory] = useState<PromptHistoryEntry[]>([]), [head, setHead] = useState(0);
  const [name, setName] = useState(""), [template, setTemplate] = useState(""), [variables, setVariables] = useState<Record<string, string>>({}), [compiled, setCompiled] = useState<PromptCompilation | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const lifetime = useRef(new AbortController()), working = useRef(false), operation = useRef(crypto.randomUUID()), selection = useRef(0), dialog = useRef<HTMLDivElement>(null);
  const dirty = name !== (source?.name ?? "") || template !== (source?.template ?? "");
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useDialogFocus(confirmation !== null || blocker.state === "blocked", dialog, () => { setConfirmation(null); if (blocker.state === "blocked") blocker.reset(); });
  useEffect(() => {
    const controller = lifetime.current;
    return () => { controller.abort(); };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const perform = useCallback(async (work: () => Promise<void>) => {
    if (working.current) return; working.current = true; setBusy(true); setError(""); setNotice("");
    try { lifetime.current.signal.throwIfAborted(); await work(); lifetime.current.signal.throwIfAborted(); }
    catch (cause) {
      if (!lifetime.current.signal.aborted && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "Prompt request failed.");
        if (cause && typeof cause === "object" && "status" in cause && [401, 403].includes(Number(cause.status))) { setSource(null); setCompiled(null); setVariables({}); setName(""); setTemplate(""); setItems([]); setHistory([]); setCapabilities(null); }
      }
    } finally { working.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  }, []);
  const request = useCallback(<T,>(path: string, options: { method?: string; body?: unknown } = {}) => client.request<T>(path, { ...options, signal: lifetime.current.signal }), [client]);
  const refresh = useCallback(async () => {
    const cap = await request<PromptCapabilities>("/capabilities"), page = await request<PromptPage>("");
    lifetime.current.signal.throwIfAborted(); setCapabilities(cap); setItems(page.items); setCursor(page.cursor);
  }, [request]);
  useEffect(() => { void perform(refresh); }, [perform, refresh]);
  async function load(id: string, revision: number, currentHead: number) {
    const ticket = ++selection.current;
    const value = await request<PromptRevision>(`/${id}/revisions/${revision}`), versions = await request<{ items: PromptHistoryEntry[] }>(`/${id}/history`);
    lifetime.current.signal.throwIfAborted(); if (ticket !== selection.current) return;
    if (value.id !== id || value.revision !== revision) throw new Error("The prompt does not match the selected revision.");
    setSource(value); setHead(currentHead); setName(value.name); setTemplate(value.template); setHistory(versions.items); setVariables({}); setCompiled(null); operation.current = crypto.randomUUID();
  }
  function afterDiscard(action: () => void) { if (dirty) setConfirmation({ title: "Discard unsaved changes?", message: "Your draft has not been saved as a revision.", action }); else action(); }
  function edit(value: string, field: "name" | "template") { operation.current = crypto.randomUUID(); if (field === "name") setName(value); else setTemplate(value); }
  async function save() {
    const saved = await request<PromptRevision>(source ? `/${source.id}/revisions` : "", { method: "POST", body: { operationKey: operation.current, name, template, ...(source ? { expectedRevision: head } : {}) } });
    await refresh(); await load(saved.id, saved.revision, saved.revision); setNotice(`Revision ${saved.revision} saved.`);
  }
  function reset() { selection.current++; setSource(null); setName(""); setTemplate(""); setHistory([]); setHead(0); setVariables({}); setCompiled(null); operation.current = crypto.randomUUID(); }
  async function reloadHead() { if (!source) return; const page = await request<PromptPage>(""); const latest = page.items.find(item => item.id === source.id); if (latest) await load(latest.id, latest.revision, latest.revision); else { const versions = await request<{ items: PromptHistoryEntry[] }>(`/${source.id}/history`); const revision = Math.max(...versions.items.map(item => item.revision)); await load(source.id, revision, revision); } await refresh(); }
  async function compile() {
    if (!source) return;
    const value = await request<PromptCompilation>(`/${source.id}/revisions/${source.revision}/compile`, { method: "POST", body: { variables: Object.fromEntries(source.variableNames.map(key => [key, variables[key] ?? ""])) } });
    if (value.id !== source.id || value.revision !== source.revision || value.templateSha256 !== source.templateSha256) throw new Error("The compiled result does not match the selected revision.");
    setCompiled(value); setNotice(`Compiled revision ${value.revision}.`);
  }
  async function exportRevision() {
    if (!source) return;
    const value = await request<PromptExport>(`/${source.id}/revisions/${source.revision}/export`);
    if (value.prompt.id !== source.id || value.prompt.revision !== source.revision || value.prompt.templateSha256 !== source.templateSha256) throw new Error("The export does not match the selected revision.");
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    try { const anchor = document.createElement("a"); anchor.href = url; anchor.download = `prompt-${source.id}-r${source.revision}.json`; anchor.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    setNotice(`Exported revision ${source.revision}.`);
  }
  const disabled = busy || !capabilities, historical = !!source && source.revision !== head;
  return <div className="prompt-workspace" data-testid="prompt-workspace">
    <header className="prompt-heading"><div><p className="prompt-eyebrow">{scopeLabel}</p><h1>Prompts</h1><p>Keep a revision you can return to. Compile saved templates with literal variables.</p></div>{canEdit && <Button size="lg" disabled={disabled} onClick={() => afterDiscard(reset)}><Plus />New prompt</Button>}</header>
    <div aria-live="polite" className="prompt-status">{busy ? "Working…" : notice && <><CheckCircle2 size={16} />{notice}</>}</div>
    {error && <div role="alert" className="prompt-error"><p>{error}</p><Button variant="outline" disabled={busy} onClick={() => void perform(refresh)}>Refresh prompts</Button>{source && canEdit && <Button variant="outline" disabled={busy} onClick={() => afterDiscard(() => void perform(reloadHead))}>Load current revision</Button>}</div>}
    <div className="prompt-layout"><aside className="prompt-library" aria-label="Saved prompts"><div className="prompt-section-title"><h2>Saved prompts</h2><span>{items.length}</span></div>
      {!items.length && !busy && <p className="prompt-muted">{capabilities ? "No prompts yet. Save your first template to start its history." : "Connect to the prompt registry to view saved templates."}</p>}
      <ul>{items.map(item => <li key={item.id}><button type="button" className={source?.id === item.id ? "selected" : ""} disabled={disabled} onClick={() => afterDiscard(() => void perform(() => load(item.id, item.revision, item.revision)))}><span>{item.name}</span><small>Revision {item.revision}</small></button></li>)}</ul>
      {cursor && <Button variant="outline" disabled={disabled} onClick={() => void perform(async () => { const page = await request<PromptPage>(`?${new URLSearchParams({ cursor })}`); setItems(previous => [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))]); setCursor(page.cursor); })}>Load more prompts</Button>}
    </aside><section className="prompt-editor" aria-labelledby="prompt-draft-title"><div className="prompt-section-title"><h2 id="prompt-draft-title"><FileCode2 size={18} />{source ? historical ? `Revision ${source.revision}` : "Current revision" : "New template"}</h2>{dirty && <span>Unsaved changes</span>}</div>
      {source && <div className="prompt-source"><span>Saved source: revision {source.revision} · literal-v1</span><code title={source.templateSha256}>SHA-256 {source.templateSha256}</code></div>}
      {historical && <p className="prompt-muted">This is a saved historical revision. Load the current revision before editing.</p>}
      <label className="prompt-field">Prompt name<Input maxLength={256} value={name} disabled={disabled || !canEdit || historical} onChange={event => edit(event.target.value, "name")} placeholder="For example, release review" /></label>
      <div className="prompt-field"><label htmlFor="prompt-template">Template</label><textarea id="prompt-template" maxLength={32768} value={template} disabled={disabled || !canEdit || historical} spellCheck={false} onChange={event => edit(event.target.value, "template")} placeholder={'Review {{topic}}.\nWrite a concise explanation.'} /></div>
      <p className="prompt-muted">Use <code>{"{{variable_name}}"}</code> for a variable. Saved revisions are immutable. Keep credentials out of names, templates and values.</p>
      <div className="prompt-actions">{canEdit && <Button size="lg" disabled={disabled || !dirty || historical} onClick={() => void perform(save)}>{source ? "Save new revision" : "Save prompt"}</Button>}{source && <Button variant="outline" size="lg" disabled={disabled} onClick={() => void perform(exportRevision)}><Download />Export revision {source.revision}</Button>}{source && historical && <Button variant="outline" size="lg" disabled={disabled} onClick={() => afterDiscard(() => void perform(reloadHead))}>Load current revision</Button>}</div>
      {source && <section className="prompt-history" aria-label="Prompt history"><h3><History size={16} />Revision history</h3><div>{history.map(entry => <Button key={entry.revision} size="lg" variant={entry.revision === source.revision ? "default" : "outline"} disabled={disabled} aria-pressed={entry.revision === source.revision} onClick={() => afterDiscard(() => void perform(() => load(source.id, entry.revision, head)))}>Revision {entry.revision}</Button>)}</div></section>}
    </section><section className="prompt-preview" aria-labelledby="prompt-preview-title"><div className="prompt-section-title"><h2 id="prompt-preview-title">Compile saved revision</h2></div>
      {!source ? <p className="prompt-muted">Save or select a prompt to try its variables and see the compiled text.</p> : <><p className="prompt-muted">Compiles revision {source.revision}. {dirty ? "Unsaved changes are excluded." : "Variables are inserted once as plain text."}</p>{source.variableNames.map(key => <div className="prompt-field" key={key}><label htmlFor={`prompt-variable-${key}`}>{key}</label><textarea id={`prompt-variable-${key}`} className="prompt-variable" maxLength={4096} value={variables[key] ?? ""} disabled={disabled} onChange={event => { setVariables(previous => ({ ...previous, [key]: event.target.value })); setCompiled(null); }} /></div>)}<Button variant="outline" size="lg" disabled={disabled} onClick={() => void perform(compile)}>Compile revision {source.revision}</Button></>}
      {compiled && <div className="prompt-output"><p>Compiled revision {compiled.revision}</p><pre data-testid="prompt-compiled">{compiled.compiled}</pre></div>}
    </section></div>
    {capabilities && canDelete && <footer className="prompt-management"><h2>Manage prompt content</h2><p>Removal permanently deletes template content. Other captured work remains available.</p><div className="prompt-actions">{source && <Button variant="outline" size="lg" disabled={disabled} onClick={() => setConfirmation({ title: "Remove this prompt?", message: "All of this prompt’s revision content will be permanently removed. Retrying an old save cannot recreate this prompt.", destructive: true, action: () => void perform(async () => { await request(`/${source.id}?expectedRevision=${head}`, { method: "DELETE" }); reset(); await refresh(); setNotice("Prompt removed."); }) })}><Trash2 />Remove prompt</Button>}<Button variant="outline" size="lg" disabled={disabled} onClick={() => setConfirmation({ title: "Clear all prompt content?", message: "This permanently removes every prompt and every saved revision in this scope, and releases reserved prompt capacity. This cannot be undone. Other captured work is retained.", destructive: true, action: () => void perform(async () => { await request("/clear", { method: "POST", body: { expectedGeneration: capabilities.generation, operationKey: crypto.randomUUID() } }); reset(); await refresh(); setNotice("All prompt content removed."); }) })}>Clear all prompts</Button></div></footer>}
    {(confirmation || blocker.state === "blocked") && <div className="prompt-dialog-shade"><div ref={dialog} role="alertdialog" aria-modal="true" aria-labelledby="prompt-confirm-title" aria-describedby="prompt-confirm-description" className="prompt-dialog"><h2 id="prompt-confirm-title">{confirmation?.title ?? "Leave unsaved changes?"}</h2><p id="prompt-confirm-description">{confirmation?.message ?? "Your draft has not been saved. Leave this page and discard it?"}</p><div className="prompt-actions"><Button variant="outline" size="lg" onClick={() => { setConfirmation(null); if (blocker.state === "blocked") blocker.reset(); }}>Keep working</Button><Button size="lg" className={confirmation?.destructive ? "prompt-danger" : ""} onClick={() => { const action = confirmation?.action; setConfirmation(null); if (action) action(); else if (blocker.state === "blocked") blocker.proceed(); }}>{confirmation?.destructive ? "Permanently remove" : "Discard changes"}</Button></div></div></div>}
  </div>;
}
