import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, CircleHelp, Copy, Play, Unplug, XCircle } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Inspection } from "../components/verification/Inspection";
import { ReportContext } from "../components/verification/ReportContext";
import { buildPredicate, describePredicate, emptyCheck, Field, PredicateEditor, Select, type CheckDraft } from "../components/verification/PredicateEditor";
import { verificationApi, type AppCommand, type CommandResult, type CreatedSession, type FlowStep, type Predicate, type RuntimeEvent, type VerificationReport, type VerificationStatus } from "../api/verification";
import { useRuns } from "../hooks/use-runs";
import { runDisplayName } from "../utils/helpers";
import { C } from "../utils/colors";

function stateSummary(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (depth >= 2) return `${entries.length} properties`;
    return entries.slice(0, 5).map(([key, item]) => `${key}: ${stateSummary(item, depth + 1)}`).join(", ") + (entries.length > 5 ? ", …" : "");
  }
  return String(value).slice(0, 180);
}

function eventSummary(event: RuntimeEvent): string {
  const data = event.data;
  switch (event.type) {
    case "network": return `${String(data.method ?? "GET")} ${String(data.url ?? "request")} → ${String(data.status ?? "unknown status")}`;
    case "network.start": return `${String(data.method ?? "GET")} ${String(data.url ?? "request")} started`;
    case "console": return `${String(data.level ?? "log")}: ${String(data.message ?? "")}`;
    case "signal": return `Signal: ${String(data.name ?? "unnamed")}`;
    case "state": return `${String(data.store ?? "unknown store")}: ${stateSummary(data.value)}`;
    case "dom": return `${String(data.selector ?? "Document")}: ${String(data.count ?? "unknown")} matching elements`;
    case "route": return `Route: ${String(data.url ?? "changed")}`;
    case "action.boundary": return "Application action started";
    default: return String(data.message ?? data.reason ?? event.type);
  }
}

function Status({ status }: { status: VerificationStatus }) {
  const Icon = status === "pass" ? CheckCircle2 : status === "fail" ? XCircle : CircleHelp;
  return <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: status === "pass" ? C.green : status === "fail" ? C.red : C.orange }}><Icon aria-hidden="true" className="size-3.5" />{status === "pass" ? "Pass" : status === "fail" ? "Fail" : "Inconclusive"}</span>;
}

function Report({ report }: { report: VerificationReport }) {
  return <article className="space-y-2 border-t border-[color:var(--rp-border)] py-4" aria-label={`${report.name}: ${report.status}`}>
    <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="min-w-0 break-words text-sm font-semibold text-[color:var(--rp-ink-strong)]">{report.name}</h3><Status status={report.status} /></div>
    <p className="break-words text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">{report.reason}</p>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--rp-ink-muted)]"><time dateTime={new Date(report.createdAt).toISOString()}>{new Date(report.createdAt).toLocaleString()}</time>{report.runId && <Link className="underline underline-offset-2" to={`/runs/${encodeURIComponent(report.runId)}`}>View linked run</Link>}</div>
    <ReportContext context={report.context} />
    {report.evidence.length > 0 && <details><summary className="cursor-pointer text-xs text-[color:var(--rp-ink-soft)]">Evidence ({report.evidence.length})</summary><ul className="mt-2 space-y-2 text-xs text-[color:var(--rp-ink)]">{report.evidence.map((event, index) => <li className="break-words" key={`${event.t}-${index}`}>{eventSummary(event)}{event.truncated && <span className="ml-1 text-[color:var(--rp-warning)]">(partial capture)</span>}</li>)}</ul></details>}
  </article>;
}

function snippet(session: CreatedSession): string {
  const sdkUrl = new URL(session.sdkUrl, window.location.origin).href;
  const daemon = new URL(session.wsUrl, window.location.origin);
  daemon.protocol = daemon.protocol === "wss:" || daemon.protocol === "https:" ? "https:" : "http:";
  return `import { connect } from ${JSON.stringify(sdkUrl)};\n\nconst verification = connect({\n  url: ${JSON.stringify(daemon.origin)},\n  sessionId: ${JSON.stringify(session.id)},\n  token: ${JSON.stringify(session.token)},\n});\n\n// Optional application outcomes:\n// verification.signal("checkout.complete");\n// verification.registerStore("cart", () => cartState);\n// verification.disconnect();`;
}

export function VerificationPage() {
  const [searchParams] = useSearchParams();
  const linkedRunId = searchParams.get("runId") ?? "";
  const queryClient = useQueryClient();
  const runs = useRuns();
  const sessions = useQuery({ queryKey: ["verification", "sessions"], queryFn: verificationApi.sessions, refetchInterval: 1000 });
  const flows = useQuery({ queryKey: ["verification", "flows"], queryFn: verificationApi.flows });
  const reports = useQuery({ queryKey: ["verification", "reports", linkedRunId], queryFn: () => verificationApi.reports(linkedRunId || undefined), refetchInterval: 2000 });
  const [origin, setOrigin] = useState("");
  const [runId, setRunId] = useState(linkedRunId);
  const [selectedId, setSelectedId] = useState("");
  const [setup, setSetup] = useState<CreatedSession | null>(null);
  const session = sessions.data?.find(item => item.id === selectedId) ?? sessions.data?.[0];
  const observation = useQuery({ queryKey: ["verification", "events", session?.id], queryFn: () => verificationApi.observe(session!.id), enabled: !!session, refetchInterval: 1000 });
  const [action, setAction] = useState<AppCommand["type"]>("snapshot");
  const [selector, setSelector] = useState("");
  const [fillValue, setFillValue] = useState("");
  const [store, setStore] = useState("");
  const [since, setSince] = useState<number>();
  const [inspection, setInspection] = useState<CommandResult | null>(null);
  const [checks, setChecks] = useState<CheckDraft[]>([emptyCheck()]);
  const [combination, setCombination] = useState<"allOf" | "anyOf">("allOf");
  const [checkName, setCheckName] = useState("");
  const [includeAction, setIncludeAction] = useState(false);
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [flowName, setFlowName] = useState("");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const connected = observation.data?.session.connected ?? session?.connected ?? false;

  useEffect(() => { setRunId(linkedRunId); }, [linkedRunId]);
  useEffect(() => {
    setSince(undefined);
    setFillValue("");
    setInspection(null);
    setSteps([]);
    setNotice("");
  }, [session?.id]);

  async function perform(label: string, operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError(null);
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : "This operation could not be completed."); }
    finally { busyRef.current = false; setBusy(""); }
  }

  function currentCommand(): AppCommand {
    if (action === "state") {
      if (!store.trim()) throw new Error("Registered store is required.");
      return { type: "state", store: store.trim() };
    }
    if (action === "snapshot") return { type: "snapshot", ...(selector.trim() ? { selector: selector.trim() } : {}) };
    if (!selector.trim()) throw new Error("Action selector is required.");
    if (action === "fill") return { type: "fill", selector: selector.trim(), value: fillValue };
    return { type: "click", selector: selector.trim() };
  }

  function currentPredicate(): Predicate {
    const predicates = checks.map(buildPredicate);
    return predicates.length === 1 ? predicates[0] : { kind: combination, predicates };
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["verification"] });
  }

  function pair(event: FormEvent) {
    event.preventDefault();
    void perform("Pairing app…", async () => {
      // Keep the one-time credential out of the React Query cache and browser storage.
      const created = await verificationApi.createSession(origin.trim(), runId || undefined);
      setSetup(created);
      setSelectedId(created.id);
      await refresh();
      setNotice("App paired. Connect the SDK in your app to begin capturing evidence.");
    });
  }

  function runAction() {
    void perform("Running action…", async () => {
      if (!session) throw new Error("Pair an app first.");
      const command = currentCommand();
      // Filled values live only in this request; React Query mutations retain variables.
      setFillValue("");
      setInspection(null);
      const result = await verificationApi.command(session.id, command);
      setSince(result.cursor);
      await refresh();
      if (!result.ok) throw new Error(result.error ?? "The app could not complete this action.");
      if (command.type === "snapshot" || command.type === "state") setInspection(result);
      setNotice(command.type === "snapshot" || command.type === "state" ? "App inspected. Review the captured evidence." : "Action completed. Check the expected outcome next.");
    });
  }

  function checkOutcome() {
    void perform("Checking outcome…", async () => {
      if (!session) throw new Error("Pair an app first.");
      const predicate = currentPredicate();
      const report = await verificationApi.assert(session.id, predicate, since, checkName.trim() || describePredicate(predicate).slice(0, 128));
      await refresh();
      setNotice(`${report.status === "pass" ? "Pass" : report.status === "fail" ? "Fail" : "Inconclusive"}: ${report.reason}`);
    });
  }

  function addStep() {
    setError(null);
    try {
      if (steps.length >= 20) throw new Error("A saved flow supports at most 20 steps.");
      if (includeAction && action === "fill") throw new Error("Saved flows cannot contain fill actions. Fill the app live, then save checks or other actions.");
      const command = includeAction ? currentCommand() : undefined;
      setSteps(previous => [...previous, { ...(command ? { command } : {}), predicate: currentPredicate() }]);
      setNotice("Step added to the flow draft.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this step."); }
  }

  const queryError = sessions.error ?? observation.error ?? flows.error ?? reports.error;
  const events = (observation.data?.events ?? []).slice(-60).reverse();
  const coverage = observation.data?.session.coverage ?? session?.coverage;
  return <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-7 p-5 pt-14 sm:p-8 sm:pt-14 lg:pt-8" style={{ background: C.bg, color: C.fg2 }}>
    <header className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight" style={{ color: C.fg3, fontFamily: "var(--font-display)" }}>Verification</h1><p className="max-w-2xl text-sm leading-relaxed" style={{ color: C.fg1 }}>Connect a local app, exercise a user action, and check what actually happened. Keep the evidence alongside the agent run.</p></header>

    <div className="sr-only" role="status" aria-live="polite">{busy || notice}</div>
    {(error || queryError) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm" style={{ borderColor: C.red, color: C.red }}><span>{error ?? queryError?.message}</span><Button variant="ghost" onClick={() => { setError(null); void refresh(); }}>Retry refresh</Button></div>}
    {notice && <p className="break-words text-xs leading-relaxed" style={{ color: C.fg1 }}>{notice}</p>}

    <section aria-labelledby="pair-heading" className="space-y-4 border-y py-5" style={{ borderColor: C.border }}>
      <h2 id="pair-heading" className="text-sm font-semibold" style={{ color: C.fg3 }}>Pair an application</h2>
      <form onSubmit={pair} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1"><Field label="App origin" hint="Exact local origin, including the port."><Input required type="url" placeholder="http://localhost:3000" value={origin} onChange={event => setOrigin(event.target.value)} /></Field></div>
        <div className="min-w-[200px] flex-1"><Field label="Link to run (optional)" hint="Checks appear beside this captured run."><Select value={runId} onChange={event => setRunId(event.target.value)}><option value="">No linked run</option>{runId && !runs.data?.some(run => run.id === runId) && <option value={runId}>Run from link</option>}{runs.data?.map(run => <option key={run.id} value={run.id}>{runDisplayName(run)}</option>)}</Select></Field></div>
        <Button type="submit" disabled={!!busy || !origin.trim()} className="mb-5">Pair app</Button>
      </form>
      {runs.isError && <p className="text-xs" style={{ color: C.orange }}>Run choices could not load. You can still pair an app without a linked run.</p>}
      {setup && <div className="space-y-3 rounded-md border p-4" style={{ background: C.surface, borderColor: C.border }}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Connect in {setup.origin}</h3><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void perform("Copying connection setup…", async () => { await navigator.clipboard.writeText(snippet(setup)); setNotice("Connection setup copied."); })}><Copy aria-hidden="true" />Copy setup</Button><Button variant="ghost" size="sm" onClick={() => setSetup(null)}>Dismiss setup</Button></div></div>
        <p className="max-w-2xl text-xs leading-relaxed" style={{ color: C.fg1 }}>Run this module in your app's development entry point. The connection credential is shown only here; keep it out of committed source. Reloading the app requires reconnecting.</p>
        <pre aria-label="Application connection snippet" className="max-h-72 overflow-auto rounded-md p-3 text-[11px] leading-relaxed" style={{ background: C.bg }}>{snippet(setup)}</pre>
      </div>}
    </section>

    <section aria-label="Application session" className="space-y-3">
      {sessions.isLoading ? <p className="text-sm" role="status">Loading app sessions…</p> : !session ? <p className="py-3 text-sm" style={{ color: C.fg1 }}>No app sessions yet. Pair your local app above, then connect the SDK to inspect it.</p> : <>
        <div className="flex flex-wrap items-end gap-3"><div className="min-w-[180px] max-w-lg flex-1"><Field label="Active session"><Select value={session.id} onChange={event => setSelectedId(event.target.value)} disabled={!!busy}>{sessions.data?.map(item => <option key={item.id} value={item.id}>{item.origin} · {item.connected ? "Connected" : "Disconnected"} · {new Date(item.createdAt).toLocaleTimeString()}</option>)}</Select></Field></div><span role="status" className="pb-2 text-xs font-medium" style={{ color: connected ? C.green : C.orange }}>{connected ? "Connected" : "Disconnected"}</span><Button variant="outline" disabled={!!busy} onClick={() => void perform("Disconnecting app…", async () => { await verificationApi.disconnect(session.id); if (setup?.id === session.id) setSetup(null); setSelectedId(""); await refresh(); setNotice("Session disconnected. Its saved reports are retained."); })}><Unplug aria-hidden="true" />Disconnect</Button></div>
        {session.runId && <Link className="inline-block text-xs underline underline-offset-2" to={`/runs/${encodeURIComponent(session.runId)}`}>Open linked run</Link>}
        {!connected && <p className="text-xs leading-relaxed" style={{ color: C.fg1 }}>The app is not connected. Use the setup snippet in your local app, or pair again if you no longer have its credential. Checks while disconnected produce an inconclusive report.</p>}
        {coverage && <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px]" aria-label="Observer coverage">{Object.entries(coverage).map(([name, available]) => <span key={name} style={{ color: available && connected ? C.fg1 : C.orange }}>{name}: {available && connected ? "observing" : "unavailable"}</span>)}</div>}
      </>}
    </section>

    {session && <div className="flex flex-wrap items-start gap-8">
      <div className="min-w-0 flex-[2_1_360px] space-y-7">
        <section aria-labelledby="action-heading" className="space-y-4">
          <h2 id="action-heading" className="text-sm font-semibold" style={{ color: C.fg3 }}>1. Exercise the app</h2>
          <fieldset disabled={!!busy || !connected} className="space-y-3">
            <Field label="Action"><Select value={action} onChange={event => { setAction(event.target.value as AppCommand["type"]); setFillValue(""); setInspection(null); }}><option value="snapshot">Snapshot</option><option value="click">Click</option><option value="fill">Fill</option><option value="state">Read state</option></Select></Field>
            {action === "state" ? <Field label="Registered store"><Input value={store} onChange={event => setStore(event.target.value)} placeholder="cart" /></Field> : <Field label="Action selector" hint={action === "snapshot" ? "Optional: narrow the snapshot to matching elements." : "Use a stable CSS selector for exactly one interactive element."}><Input value={selector} onChange={event => setSelector(event.target.value)} placeholder='[data-testid="checkout"]' /></Field>}
            {action === "fill" && <Field label="Fill value" hint="Used only for this live action. Cleared after sending and excluded from saved flows."><Input type="password" autoComplete="new-password" value={fillValue} onChange={event => setFillValue(event.target.value)} /></Field>}
            <Button onClick={runAction}><Play aria-hidden="true" />Run action</Button>
          </fieldset>
          {inspection && <Inspection response={inspection} onSelect={value => setSelector(value)} />}
        </section>
        <section aria-labelledby="outcome-heading" className="space-y-4">
          <h2 id="outcome-heading" className="text-sm font-semibold" style={{ color: C.fg3 }}>2. Check the outcome</h2>
          <p className="text-xs leading-relaxed" style={{ color: C.fg1 }}>{since === undefined ? "Check the current app and captured interval." : "Checks use evidence captured after the last action."} Missing coverage, a disconnected app, or incomplete capture produces an inconclusive result. An absence check covers the observed quiet interval.</p>
          <fieldset disabled={!!busy} className="space-y-4">
            <Field label="Check name (optional)"><Input value={checkName} onChange={event => setCheckName(event.target.value)} placeholder="Checkout completes" maxLength={128} /></Field>
            {checks.map((draft, index) => <PredicateEditor key={index} index={index} draft={draft} onChange={next => setChecks(previous => previous.map((item, at) => at === index ? next : item))} onRemove={checks.length > 1 ? () => setChecks(previous => previous.filter((_, at) => at !== index)) : undefined} />)}
            {checks.length > 1 && <Field label="Combine outcomes"><Select value={combination} onChange={event => setCombination(event.target.value as "allOf" | "anyOf")}><option value="allOf">All outcomes must pass</option><option value="anyOf">At least one outcome must pass</option></Select></Field>}
            <div className="flex flex-wrap gap-2"><Button onClick={checkOutcome}>Check outcome</Button><Button variant="ghost" disabled={checks.length >= 10} onClick={() => setChecks(previous => [...previous, emptyCheck()])}>Add expected outcome</Button></div>
          </fieldset>
        </section>
        <section aria-labelledby="draft-heading" className="space-y-4 border-t pt-5" style={{ borderColor: C.border }}>
          <h2 id="draft-heading" className="text-sm font-semibold" style={{ color: C.fg3 }}>3. Save a repeatable flow</h2>
          <p className="text-xs leading-relaxed" style={{ color: C.fg1 }}>Build a sequence of actions and checks for this origin. Saved flows exclude all fill actions to keep entered values out of storage. Fill the app live before replaying a flow that needs input.</p>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includeAction} onChange={event => setIncludeAction(event.target.checked)} disabled={!!busy} />Include current action in step</label>
          <Button variant="outline" onClick={addStep} disabled={!!busy || steps.length >= 20}>Add step to flow</Button>
          {steps.length > 0 && <ol className="space-y-3 text-xs">{steps.map((step, index) => <li className="flex items-start justify-between gap-3" key={index}><span className="min-w-0 break-words"><span className="mr-2" style={{ color: C.fg0 }}>{index + 1}.</span>{step.command ? `${step.command.type} → ` : ""}{describePredicate(step.predicate)}</span><Button size="sm" variant="ghost" aria-label={`Remove flow step ${index + 1}`} disabled={!!busy} onClick={() => setSteps(previous => previous.filter((_, at) => at !== index))}>Remove</Button></li>)}</ol>}
          <Field label="Flow name"><Input value={flowName} onChange={event => setFlowName(event.target.value)} placeholder="Checkout smoke check" maxLength={128} /></Field>
          <Button disabled={!!busy || !steps.length || !flowName.trim()} onClick={() => void perform("Saving flow…", async () => { await verificationApi.saveFlow(flowName.trim(), session.origin, steps); setSteps([]); setFlowName(""); await refresh(); setNotice("Flow saved. Replay it against a connected app at the same origin."); })}>Save flow</Button>
        </section>
      </div>
      <section aria-labelledby="evidence-heading" className="min-w-0 flex-[1_1_280px] space-y-3 border-t pt-5" style={{ borderColor: C.border }}>
        <div className="flex items-center justify-between gap-3"><h2 id="evidence-heading" className="text-sm font-semibold" style={{ color: C.fg3 }}>Live evidence</h2><span className="text-[11px]" style={{ color: C.fg0 }}>Latest {events.length}</span></div>
        {observation.isLoading ? <p className="text-xs" role="status">Loading captured evidence…</p> : !events.length ? <p className="text-xs leading-relaxed" style={{ color: C.fg1 }}>No events captured. Connect the app and run an action, or interact with it directly.</p> : <ul className="max-h-[620px] space-y-0 overflow-auto pr-1">{events.map((event, index) => <li key={`${event.t}-${index}`} className="space-y-1 border-b py-3" style={{ borderColor: C.border }}><span className="text-[10px] font-medium" style={{ color: C.fg0 }}>{event.type}</span><p className="break-words text-xs leading-relaxed">{eventSummary(event)}</p>{event.truncated && <span className="text-[11px]" style={{ color: C.orange }}>Partial capture</span>}</li>)}</ul>}
        {(observation.data?.complete === false || (session.dropped ?? 0) > 0) && <p className="text-xs leading-relaxed" style={{ color: C.orange }}>Some evidence is unavailable or was dropped. Checks cannot establish a pass from incomplete capture.</p>}
      </section>
    </div>}

    <section aria-labelledby="flows-heading" className="space-y-3 border-t pt-5" style={{ borderColor: C.border }}>
      <h2 id="flows-heading" className="text-sm font-semibold" style={{ color: C.fg3 }}>Saved flows</h2>
      {flows.isLoading ? <p role="status" className="text-xs">Loading saved flows…</p> : !flows.data?.length ? <p className="text-xs" style={{ color: C.fg1 }}>No saved flows. Add an expected outcome to a flow draft above to reuse it.</p> : <ul className="divide-y divide-[color:var(--rp-border)]">{flows.data.map(flow => <li key={flow.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0 space-y-1"><h3 className="break-words text-sm font-medium">{flow.name}</h3><p className="break-words text-[11px]" style={{ color: C.fg1 }}>{flow.origin} · {flow.steps.length} {flow.steps.length === 1 ? "step" : "steps"}</p>{session && session.origin !== flow.origin && <p className="text-[11px]" style={{ color: C.orange }}>Select a connected session at this origin to replay.</p>}</div><div className="flex gap-2"><Button variant="outline" disabled={!!busy || !connected || !session || session.origin !== flow.origin} aria-label={`Replay ${flow.name}`} onClick={() => void perform("Replaying flow…", async () => { const report = await verificationApi.runFlow(flow.id, session!.id); await refresh(); setNotice(`${flow.name}: ${report.status}. ${report.reason}`); })}><Play aria-hidden="true" />Replay</Button><Button variant="ghost" disabled={!!busy} aria-label={`Delete ${flow.name}`} onClick={() => void perform("Deleting flow…", async () => { await verificationApi.deleteFlow(flow.id); await refresh(); setNotice("Flow deleted. Its previous reports remain available."); })}>Delete</Button></div></li>)}</ul>}
    </section>
    <section aria-labelledby="reports-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="reports-heading" className="text-sm font-semibold" style={{ color: C.fg3 }}>Verification reports</h2>{linkedRunId && <Link to="/verification" className="text-xs underline underline-offset-2">Show reports for all runs</Link>}</div>
      <p className="text-xs" style={{ color: C.fg1 }}>{linkedRunId ? "Showing the latest reports for the linked run." : "The latest 100 saved reports remain available after a session disconnects."}</p>
      {reports.isLoading ? <p role="status" className="text-xs">Loading reports…</p> : !reports.data?.length ? <p className="py-3 text-xs" style={{ color: C.fg1 }}>No verification reports yet. Check an outcome or replay a saved flow to create one.</p> : reports.data.map(report => <Report key={report.id} report={report} />)}
    </section>
  </div>;
}
