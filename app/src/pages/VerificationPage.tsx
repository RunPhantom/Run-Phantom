import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Check, Copy, Play, Unplug, ArrowUpRight } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge, StatusPill } from "../components/ui/badge";
import { EmptyPanel } from "../components/ui/empty-panel";
import { Meta, PageHeader } from "../components/ui/typography";
import { checkbox, checkLabel, emptyNote, lede, panel, SectionHead, summary, textLink, warningNote } from "../components/verification/section";
import { cn } from "@/lib/utils";
import { BusinessEvidence } from "../components/verification/BusinessEvidence";
import { WorkspaceNavigation } from "../components/verification/WorkspaceNavigation";
import { Inspection } from "../components/verification/Inspection";
import { FlowRepair } from "../components/verification/FlowRepair";
import { SemanticInspector } from "../components/verification/SemanticInspector";
import { TrustedBrowser } from "../components/verification/TrustedBrowser";
import { SnapshotDiff } from "../components/verification/SnapshotDiff";
import { ReportContext } from "../components/verification/ReportContext";
import { PerformanceEvidence } from "../components/verification/PerformanceEvidence";
import { buildPredicate, describePredicate, emptyCheck, Field, PredicateEditor, Select, type CheckDraft } from "../components/verification/PredicateEditor";
import { verificationApi, type AppCommand, type CommandResult, type CreatedSession, type FlowStep, type Predicate, type RuntimeEvent, type VerificationReport, type VerificationStatus } from "../api/verification";
import { useRuns } from "../hooks/use-runs";
import { ago, plural, runDisplayName } from "../utils/helpers";
import { relativeTargets } from "../../../src/verification/protocol";

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
    case "network.body": return `Response ${String(data.requestId)}: ${String(data.state)} (${String(data.bytes)} bytes)`;
    case "network.start": return `${String(data.method ?? "GET")} ${String(data.url ?? "request")} started`;
    case "console": return `${String(data.level ?? "log")}: ${String(data.message ?? "")}`;
    case "signal": return `Signal: ${String(data.name ?? "unnamed")}`;
    case "state": return `${String(data.store ?? "unknown store")}: ${stateSummary(data.value)}`;
    case "dom": return `${String(data.selector ?? "Document")}: ${String(data.count ?? "unknown")} matching elements`;
    case "route": return `Route: ${String(data.url ?? "changed")}`;
    case "action.boundary": return "Application action started";
    case "action.reading": case "verification.baseline": return `${String(data.phase ?? "Captured")} action reading: ${stateSummary(data.value)}`;
    case "action.result": return "SDK-reported action result acknowledged";
    default: return String(data.message ?? data.reason ?? event.type);
  }
}

function Status({ status }: { status: VerificationStatus }) {
  return <StatusPill status={status === "pass" ? "success" : status === "fail" ? "danger" : "warning"}>{status === "pass" ? "Pass" : status === "fail" ? "Fail" : "Inconclusive"}</StatusPill>;
}

function Report({ report }: { report: VerificationReport }) {
  return <article className="rp-fade-rise min-w-0 space-y-3 rounded-lg border border-rp-line bg-rp-surface p-5 sm:p-6" aria-label={`${report.name}: ${report.status}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><h3 className="min-w-0 break-words text-[15px] font-semibold leading-6 text-rp-ink">{report.name}</h3><Status status={report.status} /></div>
    <p className="break-words text-[13px] leading-[1.7] text-rp-ink-muted">{report.reason}</p>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><time className="rp-meta" dateTime={new Date(report.createdAt).toISOString()}>{new Date(report.createdAt).toLocaleString()}</time>{report.runId && <Link className={cn(textLink, "text-[12px]")} to={`/runs/${encodeURIComponent(report.runId)}`}>View linked run<ArrowUpRight aria-hidden="true" className="size-3" /></Link>}</div>
    <ReportContext context={report.context} report={report} />
    {report.evidence.some(event => event.type === "network.body") && <BusinessEvidence events={report.evidence} enabled connected={false} retained />}
    {report.evidence.length > 0 && <details className="border-t border-rp-line-muted pt-3"><summary className={summary}>Evidence ({report.evidence.length})</summary><ul className="mt-2 divide-y divide-rp-line-muted text-[12px] text-rp-ink">{report.evidence.map((event, index) => <li className="break-words py-2" key={`${event.t}-${index}`}><span className="rp-meta mr-2">{event.type}</span><span>{eventSummary(event)}</span>{event.truncated && <span className="ml-1 text-rp-warning">(partial capture)</span>}</li>)}</ul></details>}
  </article>;
}

type OperationScope = "pair" | "session" | "action" | "outcome" | "flow" | "flows" | "performance";
type OperationError = { scope: OperationScope; message: string };

// Focus moves to the refusal: an operation disables the control that started it, which drops
// keyboard focus to the document body, far from the form that needs correcting.
function OperationAlert({ error }: { error: OperationError }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { ref.current?.focus(); }, [error]);
  return <p ref={ref} role="alert" tabIndex={-1} className="rp-fade-rise break-words rounded-md border border-rp-danger-border bg-rp-danger-soft px-3 py-2.5 text-[13px] leading-5 text-rp-danger">{error.message}</p>;
}

function snippet(session: CreatedSession, performance = false, businessResponses = false): string {
  const sdkUrl = new URL(session.sdkUrl, window.location.origin).href;
  const daemon = new URL(session.wsUrl, window.location.origin);
  daemon.protocol = daemon.protocol === "wss:" || daemon.protocol === "https:" ? "https:" : "http:";
  return `import { connect } from ${JSON.stringify(sdkUrl)};\n\nconst verification = connect({\n  url: ${JSON.stringify(daemon.origin)},\n  sessionId: ${JSON.stringify(session.id)},\n  token: ${JSON.stringify(session.token)},\n${businessResponses ? "  businessResponses: true,\n" : ""}${performance ? '  performanceEvidence: { enabled: true, metadata: "none" },\n' : ""}});\n\n// Optional application outcomes:\n// verification.signal("checkout.complete");\n// verification.registerStore("cart", () => cartState);\n// verification.disconnect();`;
}

function SummaryTile({ label, value, detail, to, tone }: { label: string; value: string; detail: ReactNode; to: string; tone?: "danger" | "success" | "warning" }) {
  return <li className="min-w-0">
    <Link to={to} preventScrollReset className="flex h-full min-w-0 flex-col bg-rp-surface px-4 py-3 transition-colors duration-fast hover:bg-rp-row-hover focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)]">
      <span className="rp-type-eyebrow text-rp-ink-subtle">{label}</span>
      <span className={cn("mt-1.5 truncate text-[22px] font-semibold leading-7 tabular-nums", tone === "danger" ? "text-rp-danger" : tone === "success" ? "text-rp-success" : tone === "warning" ? "text-rp-warning" : "text-rp-ink")}>{value}</span>
      <span className="mt-0.5 truncate text-12 text-rp-ink-muted">{detail}</span>
    </Link>
  </li>;
}

type PairStep = { label: string; state: "done" | "current" | "todo" };

function PairProgress({ steps }: { steps: PairStep[] }) {
  return <ol aria-label="Pairing progress" className="grid gap-px overflow-hidden rounded-md border border-rp-line bg-rp-line sm:grid-cols-3">
    {steps.map((step, index) => <li key={step.label} aria-current={step.state === "current" ? "step" : undefined} className={cn("flex min-w-0 items-center gap-2.5 px-3 py-2.5 text-[13px]", step.state === "current" ? "bg-rp-wash" : "bg-rp-surface")}>
      <span aria-hidden="true" className={cn("grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold tabular-nums",
        step.state === "done" ? "border-transparent bg-rp-success-soft text-rp-success" : step.state === "current" ? "border-rp-blue text-rp-blue" : "border-rp-line text-rp-ink-muted")}>
        {step.state === "done" ? <Check className="size-3" /> : index + 1}
      </span>
      <span className={cn("min-w-0 truncate", step.state === "todo" ? "text-rp-ink-muted" : "font-medium text-rp-ink")}>{step.label}</span>
      <span className="sr-only">{step.state === "done" ? " (done)" : step.state === "current" ? " (current step)" : " (not started)"}</span>
    </li>)}
  </ol>;
}

export function VerificationPage() {
  const [searchParams] = useSearchParams();
  const linkedRunId = searchParams.get("runId") ?? "";
  const queryClient = useQueryClient();
  const runs = useRuns();
  const sessions = useQuery({ queryKey: ["verification", "sessions"], queryFn: verificationApi.sessions, refetchInterval: 1000 });
  const flows = useQuery({ queryKey: ["verification", "flows"], queryFn: verificationApi.flows, refetchInterval: 2000 });
  const reports = useQuery({ queryKey: ["verification", "reports", linkedRunId], queryFn: () => verificationApi.reports(linkedRunId || undefined), refetchInterval: 2000 });
  const [reportStatus, setReportStatus] = useState<VerificationStatus | "all">("all");
  const [reportSearch, setReportSearch] = useState("");
  const [origin, setOrigin] = useState("");
  const [runId, setRunId] = useState(linkedRunId);
  const [selectedId, setSelectedId] = useState("");
  const [captureResponses, setCaptureResponses] = useState(false);
  const [setupCapture, setSetupCapture] = useState(false);
  const [setup, setSetup] = useState<CreatedSession | null>(null);
  const [performanceOptIn, setPerformanceOptIn] = useState(false);
  const session = sessions.data?.find(item => item.id === selectedId) ?? sessions.data?.[0];
  const observation = useQuery({ queryKey: ["verification", "events", session?.id], queryFn: () => verificationApi.observe(session!.id), enabled: !!session, refetchInterval: 1000 });
  const [action, setAction] = useState<"snapshot" | "click" | "fill" | "state">("snapshot");
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
  const operationEpoch = useRef(0);
  const scope = `${session?.id ?? ""}:${linkedRunId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const [error, setError] = useState<OperationError | null>(null);
  const [notice, setNotice] = useState("");
  const connected = observation.data?.session.connected ?? session?.connected ?? false;

  useEffect(() => () => { operationEpoch.current++; busyRef.current = false; }, []);
  useEffect(() => { setRunId(linkedRunId); setSetup(null); }, [linkedRunId]);
  useEffect(() => {
    operationEpoch.current++; busyRef.current = false; setBusy(""); setError(null);
    setSince(undefined);
    setFillValue("");
    setInspection(null);
    setSteps([]);
    setNotice("");
  }, [session?.id, linkedRunId]);

  async function perform(label: string, operationScope: OperationScope, operation: (current: () => boolean) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    const ownedScope = currentScope.current, ticket = ++operationEpoch.current;
    const current = () => operationEpoch.current === ticket && currentScope.current === ownedScope;
    setBusy(label);
    setError(null);
    try { await operation(current); } catch (cause) { if (current()) setError({ scope: operationScope, message: cause instanceof Error ? cause.message : "This operation could not be completed." }); }
    finally { if (current()) { busyRef.current = false; setBusy(""); } }
  }

  function currentCommand(): AppCommand {
    const targets = checks.some(check => check.kind === "relative") ? relativeTargets(currentPredicate()) : [];
    if (targets.length && action !== "click") throw new Error("Action transitions require a Click action. Configure the outcome before running it.");
    if (action === "state") {
      if (!store.trim()) throw new Error("Registered store is required.");
      return { type: "state", store: store.trim() };
    }
    if (action === "snapshot") return { type: "snapshot", ...(selector.trim() ? { selector: selector.trim() } : {}) };
    if (!selector.trim()) throw new Error("Action selector is required.");
    if (action === "fill") return { type: "fill", selector: selector.trim(), value: fillValue };
    return targets.length ? { type: "causal-click", selector: selector.trim(), targets } : { type: "click", selector: selector.trim() };
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
    void perform("Pairing app…", "pair", async current => {
      // Keep the one-time credential out of the React Query cache and browser storage.
      const created = await verificationApi.createSession(origin.trim(), runId || undefined);
      if (!current()) return;
      setSetupCapture(captureResponses);
      setSetup(created);
      setSelectedId(created.id);
      await refresh();
      if (current()) setNotice("App paired. Connect the SDK in your app to begin capturing evidence.");
    });
  }

  function runAction() {
    void perform("Running action…", "action", async current => {
      if (!session) throw new Error("Pair an app first.");
      const command = currentCommand();
      // Filled values live only in this request; React Query mutations retain variables.
      setFillValue("");
      setInspection(null);
      const result = await verificationApi.command(session.id, command);
      if (!current()) return;
      setSince(result.cursor);
      await refresh();
      if (!current()) return;
      if (!result.ok) throw new Error(result.error ?? "The app could not complete this action.");
      if (command.type === "snapshot" || command.type === "state") setInspection(result);
      setNotice(command.type === "snapshot" || command.type === "state" ? "App inspected. Review the captured evidence." : "Action completed. Check the expected outcome next.");
    });
  }

  function checkOutcome() {
    void perform("Checking outcome…", "outcome", async current => {
      if (!session) throw new Error("Pair an app first.");
      const predicate = currentPredicate();
      const report = await verificationApi.assert(session.id, predicate, since, checkName.trim() || describePredicate(predicate).slice(0, 128));
      if (!current()) return;
      await refresh();
      if (!current()) return;
      setNotice(`${report.status === "pass" ? "Pass" : report.status === "fail" ? "Fail" : "Inconclusive"}: ${report.reason}`);
    });
  }

  function addStep() {
    setError(null);
    try {
      if (steps.length >= 20) throw new Error("A saved flow supports at most 20 steps.");
      if (includeAction && action === "fill") throw new Error("Saved flows cannot contain fill actions. Fill the app live, then save checks or other actions.");
      if (!includeAction && checks.some(check => check.kind === "relative")) throw new Error("Include the Click action when saving an action transition.");
      const command = includeAction ? currentCommand() : undefined;
      setSteps(previous => [...previous, { ...(command ? { command } : {}), predicate: currentPredicate() }]);
      setNotice("Step added to the flow draft.");
    } catch (cause) { setError({ scope: "flow", message: cause instanceof Error ? cause.message : "Could not add this step." }); }
  }

  const queryError = sessions.error ?? observation.error ?? flows.error ?? reports.error;
  const operationAlert = (scope: OperationScope) => error?.scope === scope ? <OperationAlert error={error} /> : null;
  const events = (observation.data?.events ?? []).slice(-60).reverse();
  const coverage = observation.data?.session.coverage ?? session?.coverage;
  const loadedReports = reports.data ?? [];
  const reportTerm = reportSearch.trim().toLocaleLowerCase();
  const filteredReports = loadedReports.filter(report => (reportStatus === "all" || report.status === reportStatus)
    && (!reportTerm || `${report.name} ${report.reason}`.toLocaleLowerCase().includes(reportTerm)));
  const verdictCount = (status: VerificationStatus) => loadedReports.filter(report => report.status === status).length;
  const connectedApps = sessions.data?.filter(item => item.connected).length ?? 0;
  const capabilities = observation.data?.session.capabilities ?? session?.capabilities;
  const latestReport = loadedReports.reduce<VerificationReport | null>((latest, report) => !latest || report.createdAt > latest.createdAt ? report : latest, null);
  const sectionLink = (section: string) => { const next = new URLSearchParams(searchParams); next.set("section", section); return `?${next}`; };
  const pairSteps: PairStep[] = [
    { label: "Enter your app's address", state: setup || session ? "done" : "current" },
    { label: "Add the snippet to your app", state: connected ? "done" : setup || session ? "current" : "todo" },
    { label: connected ? "Connected" : "Wait for it to connect", state: connected ? "done" : "todo" },
  ];
  return <div className="mx-auto flex min-h-full w-full max-w-[1440px] min-w-0 flex-col gap-6 rp-page text-rp-ink">
    <PageHeader
      eyebrow="Ship / App checks"
      title="Verification"
      description="Drive your running app, check what actually happened, and keep the evidence next to the agent run."
    />
    <ul aria-label="Verification summary" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rp-line bg-rp-line lg:grid-cols-4">
      <SummaryTile label="Apps" to={sectionLink("pair")}
        value={sessions.isSuccess ? `${connectedApps} connected` : "—"}
        detail={sessions.isSuccess ? sessions.data.length ? `${plural(sessions.data.length, "app")} paired` : "Pair an app to start" : sessions.isError ? "Connections unavailable" : "Reading connections…"}
        tone={sessions.isSuccess && connectedApps > 0 ? "success" : undefined} />
      <SummaryTile label={linkedRunId ? "Reports · this run" : "Reports"} to={sectionLink("reports")}
        value={reports.isSuccess ? String(loadedReports.length) : "—"}
        detail={reports.isSuccess ? loadedReports.length ? `${verdictCount("pass")} pass · ${verdictCount("fail")} fail · ${verdictCount("inconclusive")} inconclusive` : "No checks run yet" : reports.isError ? "Reports unavailable" : "Loading reports…"}
        tone={reports.isSuccess && verdictCount("fail") > 0 ? "danger" : undefined} />
      <SummaryTile label="Latest result" to={sectionLink("reports")}
        value={latestReport ? latestReport.status === "pass" ? "Pass" : latestReport.status === "fail" ? "Fail" : "Inconclusive" : "—"}
        detail={latestReport ? <span title={latestReport.reason}>{latestReport.name} · {ago(latestReport.createdAt)}</span> : "After your first check"}
        tone={latestReport ? latestReport.status === "pass" ? "success" : latestReport.status === "fail" ? "danger" : "warning" : undefined} />
      <SummaryTile label="Saved flows" to={sectionLink("flows")}
        value={flows.isSuccess ? String(flows.data.length) : "—"}
        detail={flows.isSuccess ? flows.data.length ? `${flows.data.reduce((sum, flow) => sum + flow.steps.length, 0)} steps to replay` : "Save a check to replay" : flows.isError ? "Flows unavailable" : "Loading flows…"} />
    </ul>
    <WorkspaceNavigation ready={!sessions.isLoading} sessionId={session?.id} reports={reports.isSuccess ? reports.data.length : undefined} />

    <div className="sr-only" role="status" aria-live="polite">{busy || notice}</div>
    {queryError && <div role="alert" className="rp-fade-rise flex flex-wrap items-center justify-between gap-3 rounded-md border border-rp-danger-border bg-rp-danger-soft px-4 py-3 text-[13px] text-rp-danger"><span className="min-w-0 break-words">{queryError.message}</span><Button variant="destructive-outline" size="sm" onClick={() => void refresh()}>Retry refresh</Button></div>}
    {notice && <p key={notice} className="rp-fade-rise flex min-w-0 items-start gap-3 break-words rounded-md border border-rp-line bg-rp-surface px-4 py-3 text-[13px] leading-5 text-rp-ink"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 bg-rp-mark" />{notice}</p>}

    <section id="verification-pair" tabIndex={-1} aria-labelledby="pair-heading" className={cn(panel, "space-y-5")}>
      <SectionHead eyebrow="Step 1 / Connect" title="Pair an application" id="pair-heading" aside={<Meta>Local only</Meta>} />
      <PairProgress steps={pairSteps} />
      <form onSubmit={pair} className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Field label="App origin" hint="Where your app runs locally, including the port."><Input required type="url" placeholder="http://localhost:3000" value={origin} onChange={event => setOrigin(event.target.value)} /></Field>
        <Field label="Link to run (optional)" hint="Results also show up on this run."><Select value={runId} onChange={event => setRunId(event.target.value)}><option value="">No linked run</option>{runId && !runs.data?.some(run => run.id === runId) && <option value={runId}>Run from link</option>}{runs.data?.map(run => <option key={run.id} value={run.id}>{runDisplayName(run)}</option>)}</Select></Field>
        <Button type="submit" disabled={!!busy || !origin.trim()} className="md:mt-6">Pair app</Button>
      </form>
      <div className="space-y-2 border-t border-rp-line-muted pt-4">
        <label className={checkLabel}><input type="checkbox" className={checkbox} checked={captureResponses} onChange={event => setCaptureResponses(event.target.checked)} disabled={!!busy} /><span>Capture response evidence<span className="rp-field-hint mt-0.5 block max-w-xl">Keep short, redacted copies of your app's responses so checks can read them. Off by default; copy the setup again after changing this.</span></span></label>
        <label className={checkLabel}><input type="checkbox" className={checkbox} checked={performanceOptIn} onChange={event => setPerformanceOptIn(event.target.checked)} disabled={!!busy} />Also record page performance (no location data)</label>
      </div>
      {operationAlert("pair")}
      {runs.isError && <p className="text-[12px] text-rp-warning">Run choices could not load. You can still pair an app without a linked run.</p>}
      {setup && <div className="rp-fade-rise space-y-3 rounded-md border border-rp-wash-border bg-rp-wash p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="min-w-0 break-words text-[14px] font-semibold">Connect in {setup.origin}</h3><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void perform("Copying connection setup…", "pair", async current => { await navigator.clipboard.writeText(snippet(setup, performanceOptIn, setupCapture)); if (current()) setNotice("Connection setup copied."); })}><Copy aria-hidden="true" />Copy setup</Button><Button variant="ghost" size="sm" onClick={() => setSetup(null)}>Dismiss setup</Button></div></div>
        <p className="max-w-2xl text-[12px] leading-[1.7] text-rp-ink-muted">Paste this into your app's development entry point, then load the app. The token is shown only here, so keep it out of source control. If you reload the app, you will need to reconnect it.</p>
        <pre aria-label="Application connection snippet" className="max-h-72 overflow-auto rounded-sm border border-rp-line bg-rp-surface p-3 font-mono text-[12px] leading-[1.7] text-rp-ink">{snippet(setup, performanceOptIn, setupCapture)}</pre>
      </div>}
    </section>

    <section aria-label="Application session" className={cn("min-w-0", session && !sessions.isLoading && !sessions.isError && "space-y-4 rounded-lg border border-rp-wash-border bg-rp-wash p-5 sm:p-6")}>
      {sessions.isLoading ? <div className="flex min-h-[72px] items-center gap-3 rounded-lg border border-rp-line bg-rp-surface px-5"><span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-rp-ink-faint motion-reduce:animate-none" /><p className="text-[13px] text-rp-ink-muted" role="status">Loading app sessions…</p></div> : sessions.isError ? <p className="rounded-lg border border-rp-danger-border bg-rp-danger-soft px-5 py-4 text-[13px] text-rp-danger">App sessions could not load. Refresh the connection list before pairing or selecting an app.</p> : !session ? <div id="verification-connect-first" tabIndex={-1} className="min-w-0"><EmptyPanel compact eyebrow="Not connected yet" title="Connect your first app" description={<><p>Enter your app's address above and add the snippet to it. Once it connects you can inspect elements, run actions and check what happened.</p><p className="mt-2">Saved flows, snapshots, the trusted browser and past reports are below and work without a connection.</p></>} /></div> : <>
        <div className="flex flex-wrap items-end gap-3"><div className="min-w-[180px] max-w-lg flex-1"><Field label="Active session"><Select className="bg-rp-surface" value={session.id} onChange={event => setSelectedId(event.target.value)} disabled={!!busy}>{sessions.data?.map(item => <option key={item.id} value={item.id}>{item.origin} · {item.connected ? "Connected" : "Disconnected"} · {new Date(item.createdAt).toLocaleTimeString()}</option>)}</Select></Field></div><StatusPill role="status" status={connected ? "success" : "warning"} live={connected} className="mb-2.5">{connected ? "Connected" : "Disconnected"}</StatusPill><Button variant="outline" disabled={!!busy} onClick={() => void perform("Disconnecting app…", "session", async current => { await verificationApi.disconnect(session.id); if (!current()) return; if (setup?.id === session.id) setSetup(null); setSelectedId(""); await refresh(); if (current()) setNotice("Session disconnected. Its saved reports are retained."); })}><Unplug aria-hidden="true" />Disconnect</Button></div>
        {operationAlert("session")}
        {session.runId && <Link className={cn(textLink, "min-h-9 text-[13px]")} to={`/runs/${encodeURIComponent(session.runId)}`}>Open linked run<ArrowUpRight aria-hidden="true" className="size-3" /></Link>}
        {!connected && <p className="max-w-[70ch] text-[13px] leading-[1.7] text-rp-ink-muted">The app is not connected. Load it with the setup snippet, or pair again if you no longer have the snippet. A check run now is saved as Inconclusive.</p>}
        {coverage && <div className="flex flex-wrap gap-1.5" aria-label="Observer coverage">{Object.entries(coverage).map(([name, available]) => <Badge key={name} mono tone={available && connected ? "outline" : "warning"}>{name}: {available && connected ? "observing" : "unavailable"}</Badge>)}</div>}
      </>}
    </section>

    {session && <div className="flex flex-wrap items-start gap-6">
      <div className="min-w-0 flex-[2_1_420px] space-y-6">
        <div className={panel}><BusinessEvidence events={observation.data?.events ?? []} connected={connected} enabled={capabilities?.includes("business-response-evidence") ?? false} /></div>
        <div id="verification-inspect" tabIndex={-1} className="min-w-0 scroll-mt-20"><SemanticInspector key={linkedRunId} sessionId={session.id} connected={connected} capable={capabilities?.includes("semantic-refs") ?? false} disabled={!!busy} onAction={cursor => { setSince(cursor); setInspection(null); }} /></div>
        <div id="verification-performance" tabIndex={-1} className={cn(panel, "space-y-4")}><PerformanceEvidence key={`${session.id}:${linkedRunId}`} sessionId={session.id} connected={connected} capable={capabilities?.includes("performance-evidence") ?? false} disabled={!!busy} perform={(label, operation) => perform(label, "performance", operation)} onReport={() => { void refresh(); setNotice("Native lab report saved. Review its window and coverage below."); }} />{operationAlert("performance")}</div>
        <section aria-labelledby="action-heading" className={cn(panel, "space-y-5")}>
          <SectionHead eyebrow="Step 01 / Act" title="1. Exercise the app" id="action-heading" />
          <fieldset disabled={!!busy || !connected} className="space-y-4">
            <Field label="Action"><Select value={action} onChange={event => { setAction(event.target.value as typeof action); setFillValue(""); setInspection(null); }}><option value="snapshot">Snapshot</option><option value="click">Click</option><option value="fill">Fill</option><option value="state">Read state</option></Select></Field>
            {action === "state" ? <Field label="Registered store"><Input value={store} onChange={event => setStore(event.target.value)} placeholder="cart" /></Field> : <Field label="Action selector" hint={action === "snapshot" ? "Optional: narrow the snapshot to matching elements." : "Use a stable CSS selector for exactly one interactive element."}><Input className="font-mono text-[13px]" value={selector} onChange={event => setSelector(event.target.value)} placeholder='[data-testid="checkout"]' /></Field>}
            {action === "fill" && <Field label="Fill value" hint="Used only for this live action. Cleared after sending and excluded from saved flows."><Input type="password" autoComplete="new-password" value={fillValue} onChange={event => setFillValue(event.target.value)} /></Field>}
            <Button onClick={runAction}><Play aria-hidden="true" />Run action</Button>
          </fieldset>
          {operationAlert("action")}
          {inspection && <Inspection response={inspection} onSelect={value => setSelector(value)} />}
        </section>
        <section id="verification-checks" tabIndex={-1} aria-labelledby="outcome-heading" className={cn(panel, "space-y-5")}>
          <SectionHead eyebrow="Step 02 / Verify" title="2. Check the outcome" id="outcome-heading" />
          <p className={lede}>{since === undefined ? "Checks look at the app as it is now." : "Checks look at what happened after the last action."} If the app disconnects or something was not captured, the result is Inconclusive, never Pass. A "did not happen" check covers only the time that was observed.</p>
          <fieldset disabled={!!busy} className="space-y-4">
            <Field label="Check name (optional)"><Input value={checkName} onChange={event => setCheckName(event.target.value)} placeholder="Checkout completes" maxLength={128} /></Field>
            {checks.map((draft, index) => <PredicateEditor key={index} index={index} draft={draft} onChange={next => setChecks(previous => previous.map((item, at) => at === index ? next : item))} onRemove={checks.length > 1 ? () => setChecks(previous => previous.filter((_, at) => at !== index)) : undefined} />)}
            {checks.length > 1 && <Field label="Combine outcomes"><Select value={combination} onChange={event => setCombination(event.target.value as "allOf" | "anyOf")}><option value="allOf">All outcomes must pass</option><option value="anyOf">At least one outcome must pass</option></Select></Field>}
            <div className="flex flex-wrap gap-2 border-t border-rp-line-muted pt-4"><Button onClick={checkOutcome}>Check outcome</Button><Button variant="outline" disabled={checks.length >= 10} onClick={() => setChecks(previous => [...previous, emptyCheck()])}>Add expected outcome</Button></div>
          </fieldset>
          {operationAlert("outcome")}
        </section>
        <section aria-labelledby="draft-heading" className={cn(panel, "space-y-5")}>
          <SectionHead eyebrow="Step 03 / Repeat" title="3. Save a repeatable flow" id="draft-heading" />
          <p className={lede}>Collect the action and check above into steps you can replay on this app. Typed values are never saved, so fill in any form yourself before replaying a flow that needs input.</p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2"><label className={cn(checkLabel, "items-center")}><input type="checkbox" className={cn(checkbox, "mt-0")} checked={includeAction} onChange={event => setIncludeAction(event.target.checked)} disabled={!!busy} />Include current action in step</label><Button variant="outline" onClick={addStep} disabled={!!busy || steps.length >= 20}>Add step to flow</Button></div>
          {operationAlert("flow")}
          {steps.length > 0 && <ol className="divide-y divide-rp-line-muted rounded-md border border-rp-line text-[13px]">{steps.map((step, index) => <li className="rp-fade-rise flex items-center justify-between gap-3 px-3 py-2" key={index}><span className="min-w-0 break-words"><span className="rp-num mr-3 text-[11px] text-rp-index">{String(index + 1).padStart(2, "0")}</span>{step.command ? <span className="rp-meta mr-1 text-rp-ink">{step.command.type} →</span> : null}{describePredicate(step.predicate)}</span><Button size="sm" variant="ghost" aria-label={`Remove flow step ${index + 1}`} disabled={!!busy} onClick={() => setSteps(previous => previous.filter((_, at) => at !== index))}>Remove</Button></li>)}</ol>}
          <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_auto]"><Field label="Flow name"><Input value={flowName} onChange={event => setFlowName(event.target.value)} placeholder="Checkout smoke check" maxLength={128} /></Field>
          <Button className="sm:mt-6" disabled={!!busy || !steps.length || !flowName.trim()} onClick={() => void perform("Saving flow…", "flow", async current => { await verificationApi.saveFlow(flowName.trim(), session.origin, steps); if (!current()) return; setSteps([]); setFlowName(""); await refresh(); if (current()) setNotice("Flow saved. Replay it against a connected app at the same origin."); })}>Save flow</Button></div>
        </section>
      </div>
      <section aria-labelledby="evidence-heading" className={cn(panel, "flex-[1_1_280px] space-y-4 lg:sticky lg:top-20")}>
        <SectionHead eyebrow="Session / Live" title="Live evidence" id="evidence-heading" aside={<Meta>Latest {events.length}</Meta>} />
        {observation.isLoading ? <p className="text-[13px] text-rp-ink-muted" role="status">Loading captured evidence…</p> : observation.isError ? <p className="text-[13px] leading-[1.7] text-rp-warning">Live evidence is unavailable. Previously captured reports remain separate from this observation.</p> : !events.length ? <p className={emptyNote}>Nothing captured yet. Run an action above or use the app; requests, console messages and state changes appear here.</p> : <ul className="-mx-2 max-h-[620px] overflow-auto">{events.map((event, index) => <li key={`${event.t}-${index}`} className="space-y-1 border-b border-rp-line-muted px-2 py-2.5 last:border-b-0"><span className="rp-meta block">{event.type}</span><p className="break-words text-[13px] leading-5 text-rp-ink">{eventSummary(event)}</p>{event.truncated && <span className="text-[12px] text-rp-warning">Partial capture</span>}</li>)}</ul>}
        {(observation.data?.complete === false || (session.dropped ?? 0) > 0) && <p className={warningNote}>Some evidence is unavailable or was dropped. Checks cannot establish a pass from incomplete capture.</p>}
      </section>
    </div>}

    <div id="verification-browser" tabIndex={-1} className="min-w-0 scroll-mt-20"><TrustedBrowser key={linkedRunId} runId={linkedRunId || undefined} onReport={() => void reports.refetch()} /></div>
    <div id="verification-snapshots" tabIndex={-1} className="min-w-0 scroll-mt-20"><SnapshotDiff key={linkedRunId} sessionId={session?.id} connected={connected} capable={capabilities?.includes("semantic-tree") ?? false} disabled={!!busy} runId={linkedRunId || undefined} /></div>
    <section id="verification-flows" tabIndex={-1} aria-labelledby="flows-heading" className={cn(panel, "space-y-4")}>
      <SectionHead eyebrow="Library / Flows" title="Saved flows" id="flows-heading" aside={flows.isSuccess ? <Meta>{flows.data.length} saved</Meta> : undefined} />
      {operationAlert("flows")}
      {flows.isLoading ? <p role="status" className="text-[13px] text-rp-ink-muted">Loading saved flows…</p> : flows.isError ? <p className="text-[13px] text-rp-danger">Saved flows could not load. Refresh before replaying or deleting a flow.</p> : !flows.data?.length ? <p className={emptyNote}>No saved flows. Add an expected outcome to a flow draft above to reuse it.</p> : <ul className="divide-y divide-rp-line-muted border-t border-rp-line-muted">{flows.data.map(flow => <li key={flow.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0 space-y-1"><h3 className="break-words text-[14px] font-semibold text-rp-ink">{flow.name}</h3><p className="rp-meta break-words">{flow.origin} · {flow.steps.length} {flow.steps.length === 1 ? "step" : "steps"}</p>{session && session.origin !== flow.origin && <p className="text-[12px] text-rp-warning">Select a connected session at this origin to replay.</p>}</div><div className="flex gap-2"><Button variant="outline" disabled={!!busy || !connected || !session || session.origin !== flow.origin} aria-label={`Replay ${flow.name}`} onClick={() => void perform("Replaying flow…", "flows", async current => { const report = await verificationApi.runFlow(flow.id, session!.id); if (!current()) return; await refresh(); if (current()) setNotice(`${flow.name}: ${report.status}. ${report.reason}`); })}><Play aria-hidden="true" />Replay</Button><Button variant="ghost" disabled={!!busy} aria-label={`Delete ${flow.name}`} onClick={() => void perform("Deleting flow…", "flows", async current => { await verificationApi.deleteFlow(flow.id); if (!current()) return; await refresh(); if (current()) setNotice("Flow deleted. Its previous reports remain available."); })}>Delete</Button></div><FlowRepair key={`${flow.id}:${session?.id ?? ""}:${linkedRunId}`} flow={flow} sessionId={session?.id ?? ""} available={!!connected && !!session && session.origin === flow.origin && !!capabilities?.includes("semantic-refs")} disabled={!!busy} onCommitted={refresh} /></li>)}</ul>}
    </section>
    <section id="verification-reports" tabIndex={-1} aria-labelledby="reports-heading" className="min-w-0 scroll-mt-20 space-y-4">
      <SectionHead eyebrow="Library / Reports" title="Verification reports" id="reports-heading" aside={linkedRunId ? <Link to="/verification" className={cn(textLink, "min-h-9 text-[13px]")}>Show reports for all runs</Link> : undefined} />
      <p className={lede}>{linkedRunId ? "The latest 100 reports for the linked run." : "The latest 100 reports. They stay after an app disconnects."} Filters apply to these loaded reports.</p>
      <div className="flex min-w-0 flex-wrap items-end gap-3 rounded-lg border border-rp-line bg-rp-surface p-4 sm:p-5">
        <div className="min-w-0 flex-[2_1_240px]"><Field label="Search reports"><Input type="search" value={reportSearch} onChange={event => setReportSearch(event.target.value)} placeholder="Name or observed reason" /></Field></div>
        <div className="min-w-0 flex-[1_1_180px]"><Field label="Report status"><Select value={reportStatus} onChange={event => setReportStatus(event.target.value as typeof reportStatus)}><option value="all">All outcomes{reports.isSuccess ? ` (${loadedReports.length})` : ""}</option><option value="pass">Pass{reports.isSuccess ? ` (${verdictCount("pass")})` : ""}</option><option value="fail">Fail{reports.isSuccess ? ` (${verdictCount("fail")})` : ""}</option><option value="inconclusive">Inconclusive{reports.isSuccess ? ` (${verdictCount("inconclusive")})` : ""}</option></Select></Field></div>
        {(reportStatus !== "all" || reportSearch) && <Button variant="ghost" onClick={() => { setReportStatus("all"); setReportSearch(""); }}>Reset report filters</Button>}
      </div>
      {reports.isLoading ? <p role="status" className="text-[13px] text-rp-ink-muted">Loading reports…</p> : reports.isError ? <p className="rounded-md border border-rp-danger-border bg-rp-danger-soft px-4 py-3 text-[13px] text-rp-danger">Reports unavailable. Refresh to read the saved outcomes; this is not an empty result.</p> : <>
        <p role="status" aria-live="polite" className="rp-meta">Showing {filteredReports.length} of {loadedReports.length} loaded reports.</p>
        {!loadedReports.length ? <EmptyPanel compact titleAs="h3" title="No verification reports yet" description="Check an outcome or replay a saved flow to create one." /> : !filteredReports.length ? <p className={emptyNote}>No loaded reports match these filters. Reset the filters to see all loaded outcomes.</p> : <div className="space-y-3">{filteredReports.map(report => <Report key={report.id} report={report} />)}</div>}
      </>}
    </section>
  </div>;
}
