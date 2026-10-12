import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { TeamApiError, projectApi, type CheckSummary, type RunSummary } from "../api/team";
import type { EvidenceAttachment, EvidenceCapability, EvidenceDialect, EvidenceInventoryRevision, EvidenceJob, EvidenceSetView } from "../../../src/evaluations/evidence-protocol";
import { EvidenceReport } from "../components/evaluations/EvidenceReport";
import { EvidenceInventoryEditor } from "../components/evaluations/EvidenceInventoryEditor";
import { checkEvidenceFiles, prepareEvidenceUpload, type EvidenceCapabilities, type EvidenceFileDraft } from "../components/evaluations/evidence-upload";
import { useAccount, useProject, useTeam, useTeamPages } from "./context";
import { Action, Badge, Empty, ErrorNotice, Field, Heading, Input, Loading, More, Select } from "./common";
import "../components/evaluations/evidence-workspace.css";

type Capabilities = EvidenceCapabilities & { access: EvidenceCapability[] };
type History = { items: { id: string; revision: number; createdAt: number }[]; truncated: boolean };
type Receipt = { job: EvidenceJob; reused?: boolean };
const formats: Record<EvidenceDialect, string> = { "junit-xml/v1": "JUnit XML", "in-toto-statement/v1": "Test-result statement", "dsse-envelope/v1": "DSSE envelope", "dsse-envelope-jsonl/v1": "DSSE JSONL" };
const activeJob = (job?: EvidenceJob) => job?.status === "queued" || job?.status === "running";
const selectionKey = (id: string, revision: number) => `${id}:${revision}`;

export function EvidencePage() {
  const project = useProject(), account = useAccount(); const { permissionRevisions } = useTeam();
  const [params, setParams] = useSearchParams();
  const requestedKind = params.get("kind");
  const kind: "run" | "inspection" | "check" = requestedKind === "check" || requestedKind === "inspection" ? requestedKind : "run";
  const runs = useTeamPages<RunSummary>([project.id, "evidence-runs"], `${projectApi(project.id)}/runs`);
  const checks = useTeamPages<CheckSummary>([project.id, "evidence-checks"], `${projectApi(project.id)}/checks`);
  const choices = kind === "check" ? checks : runs;
  const items: (RunSummary | CheckSummary)[] = kind === "check" ? checks.data?.pages.flatMap(page => page.items) ?? [] : runs.data?.pages.flatMap(page => page.items) ?? [];
  const selected = items.find(item => item.id === params.get("attachment"));
  const attachment: EvidenceAttachment | null = selected ? { kind, id: selected.id } : null;
  function choose(nextKind: string, id = "") {
    setParams(id ? { kind: nextKind, attachment: id } : { kind: nextKind });
  }
  return <div className="team-page team-report-workspace" data-testid="team-evidence-workspace">
    <Heading title="External reports">Attach report observations to this project’s captured work. Reports do not replace an original verdict or prove execution.</Heading>
    <section className="team-section team-report-attachment" aria-label="Report attachment">
      <h2>Attach to existing work</h2><div className="evidence-grid">
        <Field label="Context type"><Select value={kind} onChange={event => choose(event.target.value)}><option value="run">Captured run</option><option value="inspection">Run inspection</option><option value="check">Frozen check</option></Select></Field>
        <Field label="Evidence attachment"><Select value={attachment?.id ?? ""} disabled={choices.isPending || !!choices.error} onChange={event => choose(kind, event.target.value)}><option value="">Choose existing {kind === "check" ? "check" : "run"}</option>{items.map(item => <option key={item.id} value={item.id}>{"displayName" in item ? item.displayName || item.name : item.name}</option>)}</Select></Field>
      </div><ErrorNotice error={choices.error} retry={() => void choices.refetch()} />{choices.isPending && <Loading text="Loading project attachments…" />}
      <More available={choices.hasNextPage} busy={choices.isFetchingNextPage} onClick={() => void choices.fetchNextPage()} />
      {params.get("attachment") && !selected && !choices.isPending && !choices.error && <p role="status" className="team-muted">The selected attachment is not in the loaded project list. Load more or choose existing work.</p>}
      {selected && "counts" in selected && <p className="team-report-original">Original frozen check verdict: <Badge value={selected.status} />. Imported observations are shown separately below.</p>}
      <p className="team-muted">Shared datasets and experiments are not available in this Team workspace. Run and check rosters are retrospective.</p>
    </section>
    <ProjectEvidence key={`${account.session.id}:${project.id}:${permissionRevisions[project.id] ?? 0}:${project.role}:${kind}:${attachment?.id ?? "none"}`} attachment={attachment} />
  </div>;
}

function ProjectEvidence({ attachment }: { attachment: EvidenceAttachment | null }) {
  const project = useProject(), account = useAccount(), queries = useQueryClient(); const { client, permissionRevisions } = useTeam();
  const root = `${projectApi(project.id)}/evidence`, scope = ["team", account.session.id, account.user.id, project.id, "evidence", project.role, permissionRevisions[project.id] ?? 0, attachment?.kind, attachment?.id];
  const [params, setParams] = useSearchParams();
  const [files, setFiles] = useState<EvidenceFileDraft[]>([]), [retainRaw, setRetainRaw] = useState(false), [useRoster, setUseRoster] = useState(false);
  const [operation, setOperation] = useState(""), [jobId, setJobId] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [notice, setNotice] = useState("");
  const [rawSource, setRawSource] = useState(""), [confirm, setConfirm] = useState<"raw" | "normalized" | "all" | null>(null);
  const lifetime = useRef(new AbortController()), urls = useRef(new Set<string>()), running = useRef(false);
  useEffect(() => { const downloads = urls.current; return () => { lifetime.current.abort(); downloads.forEach(url => URL.revokeObjectURL(url)); downloads.clear(); }; }, []);
  const ready = useQuery({ queryKey: [...scope, "ready"], retry: false, queryFn: async ({ signal }) => {
    const capabilities = await client.evidence<Capabilities>(`${root}/capabilities`, { signal });
    if (!attachment) return { capabilities, history: { items: [], truncated: false } as History, inventory: null };
    // A missing roster intentionally shares404 with revoked membership. A fresh
    // history read afterwards must establish this attachment's current authority.
    let inventory: EvidenceInventoryRevision | null = null;
    try { inventory = await client.evidence<EvidenceInventoryRevision>(`${root}/inventories?${new URLSearchParams({ anchor: JSON.stringify(attachment) })}`, { signal }); }
    catch (cause) { if (!(cause instanceof TeamApiError && cause.status === 404)) throw cause; }
    const history = await client.evidence<History>(`${root}/sets?${new URLSearchParams({ attachment: JSON.stringify(attachment) })}`, { signal });
    return { capabilities, history, inventory };
  } });
  const selectedKey = params.get("report") ?? "", chosen = ready.data?.history.items.find(item => selectionKey(item.id, item.revision) === selectedKey);
  const report = useQuery({ queryKey: [...scope, "report", selectedKey], retry: false, enabled: !!chosen && ready.isSuccess && !ready.error, queryFn: async ({ signal }) => {
    const value = await client.evidence<EvidenceSetView>(`${root}/sets/${encodeURIComponent(chosen!.id)}?revision=${chosen!.revision}`, { signal });
    if (value.revision.id !== chosen!.id || value.revision.revision !== chosen!.revision || value.revision.scope.kind !== "project" || value.revision.scope.id !== project.id || value.revision.attachment.kind !== attachment?.kind || value.revision.attachment.id !== attachment.id) throw new TeamApiError(409, "invalid_response", "The report does not match this selected project attachment.");
    return value;
  } });
  const job = useQuery({ queryKey: [...scope, "job", jobId], retry: false, enabled: !!jobId && ready.isSuccess && !ready.error, queryFn: ({ signal }) => client.evidence<Receipt>(`${root}/imports/${encodeURIComponent(jobId)}`, { signal }), refetchInterval: query => activeJob(query.state.data?.job) ? 500 : false });
  const failure = error ?? ready.error ?? report.error ?? job.error;
  const authorized = ready.isSuccess && !failure, access = authorized ? ready.data.capabilities.access : [];
  const can = (capability: EvidenceCapability) => access.includes(capability);
  const active = activeJob(job.data?.job), blocked = busy || active || !authorized;
  const view = authorized && !report.error ? report.data : undefined;
  useEffect(() => {
    if (!failure) return;
    lifetime.current.abort(); urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear();
    setFiles([]); setRawSource(""); setRetainRaw(false); setUseRoster(false); setConfirm(null);
  }, [failure]);
  const terminal = job.data?.job.status;
  useEffect(() => {
    if (terminal === "completed") void queries.invalidateQueries({ queryKey: [...scope, "ready"], exact: true });
  // A completed operation refreshes only its project/attachment, once per status.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, jobId, queries]);

  function selectReport(value: string) {
    setRawSource(""); setConfirm(null);
    setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set("report", value); else next.delete("report"); return next; });
  }
  useEffect(() => {
    if (job.data?.job.status !== "completed" || !job.data.job.setId || !ready.data || ready.isFetching) return;
    const item = ready.data.history.items.find(value => value.id === job.data!.job.setId);
    if (item) selectReport(selectionKey(item.id, item.revision));
  // The durable job can select only a set in this authorized attachment history.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.job.setId, job.data?.job.status, ready.data, ready.isFetching]);

  async function perform<T>(work: (signal: AbortSignal) => Promise<T>, done?: (value: T) => void): Promise<boolean> {
    if (running.current || !authorized) return false;
    running.current = true; setBusy(true); setError(null); setNotice("");
    const controller = lifetime.current;
    try { controller.signal.throwIfAborted(); const result = await work(controller.signal); controller.signal.throwIfAborted(); done?.(result); return true; }
    catch (cause) { if (!controller.signal.aborted) setError(cause); return false; }
    finally { if (!controller.signal.aborted) setBusy(false); running.current = false; }
  }
  function retry() {
    lifetime.current.abort(); lifetime.current = new AbortController(); setError(null); setBusy(false); setFiles([]); setRawSource(""); setNotice("");
    void queries.resetQueries({ queryKey: scope });
  }
  function download(blob: Blob, name: string) {
    lifetime.current.signal.throwIfAborted();
    const url = URL.createObjectURL(blob); urls.current.add(url);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
    window.setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
  }
  async function importFiles(signal: AbortSignal) {
    const key = operation || crypto.randomUUID(); setOperation(key);
    const upload = await prepareEvidenceUpload(files, ready.data!.capabilities, { attachment: attachment!, inventory: useRoster && ready.data!.inventory ? ready.data!.inventory : null, retention: retainRaw ? "raw_and_normalized" : "normalized_only", operationKey: key, signal });
    return client.evidence<Receipt>(`${root}/imports`, { method: "POST", body: upload.body, signal });
  }
  function admitted(receipt: Receipt) { setJobId(receipt.job.id); setFiles([]); setNotice(receipt.reused ? "Recovered the original durable operation." : "Reports admitted. 202 is not a completed report; current status appears below."); }
  const setRoot = view ? `${root}/sets/${encodeURIComponent(view.revision.id)}` : "";
  return <div className="team-report-content">
    <ErrorNotice error={failure} retry={retry} />{notice && !failure && <p role="status" className="team-notice">{notice}</p>}
    {ready.isPending && <Loading text="Checking project report access…" />}
    {!attachment ? <Empty title="Choose captured work"><p>Select an existing run, inspection or frozen check above before choosing files.</p></Empty> : authorized && <>
      <section className="team-section" aria-label="Saved external reports"><Field label="Saved external report"><Select value={chosen ? selectedKey : ""} disabled={busy || active} onChange={event => selectReport(event.target.value)}><option value="">Choose a saved report</option>{ready.data.history.items.map(item => <option key={selectionKey(item.id, item.revision)} value={selectionKey(item.id, item.revision)}>{item.id} · revision {item.revision}</option>)}</Select></Field>
        {!ready.data.history.items.length && <p className="team-muted">No saved external reports for this attachment yet.</p>}{ready.data.history.truncated && <p role="status" className="team-muted">This bounded history is truncated. Older revisions may not be shown.</p>}
        {selectedKey && !chosen && <p role="status" className="team-muted">The selected revision is unavailable in this attachment’s current history.</p>}
      </section>
      <section className="team-section" aria-label="Expected report inventory"><div className="evidence-row"><h2>Expected report inventory</h2><span className="evidence-badge">{ready.data.inventory ? `Revision ${ready.data.inventory.revision} · retrospective` : "Not declared"}</span></div>
        <p className="team-muted">Declare the source roster independently of selected files. A retrospective roster cannot prove complete coverage.</p>
        {ready.data.inventory && <p className="evidence-roster-summary">{ready.data.inventory.expected.map(item => `${item.shardId} (${item.kind})`).join(" · ")}</p>}
        {can("inventory_edit") ? <EvidenceInventoryEditor key={attachment.kind + attachment.id} inventory={ready.data.inventory} prospective={false} busy={blocked} onSave={(expectedRevision, expected) => perform(signal => client.evidence(`${root}/inventories`, { method: "PUT", body: { anchor: attachment, expectedRevision, expected }, signal }), () => { void ready.refetch(); setNotice("Expected roster saved as a new immutable revision."); })} /> : <p className="team-muted">An admin can declare or revise the expected roster.</p>}
      </section>
      {can("import") ? <section className="team-section" aria-label="Import external reports"><h2>Import report files</h2><p className="team-muted">Up to 32 files · 2 MiB each · 8 MiB total. No server paths or URLs.</p>
        <Field label="Report files"><input className="team-input" type="file" multiple accept=".xml,.json,.jsonl,application/xml,application/json" disabled={blocked || !!operation || ready.isFetching} onChange={event => { const selected = Array.from(event.target.files ?? []); try { checkEvidenceFiles(selected, ready.data.capabilities); setFiles(selected.map((file, index) => ({ file, sourceId: `report-${index + 1}`, shardId: "", dialect: file.name.endsWith(".jsonl") ? "dsse-envelope-jsonl/v1" : file.name.endsWith(".json") ? "in-toto-statement/v1" : "junit-xml/v1" }))); setError(null); } catch (cause) { setFiles([]); setError(cause); } event.target.value = ""; }} /></Field>
        {!files.length && <p className="team-muted">Choose local files, then review each format and source identity. Unsupported or malformed reports remain unknown.</p>}
        {files.map((draft, index) => <fieldset className="evidence-file" key={index}><legend>Selected report {index + 1}</legend><p className="evidence-filename">{draft.file.name} ·{draft.file.size.toLocaleString()} bytes</p><div className="evidence-grid"><Field label={`Source ID ${index + 1}`}><Input maxLength={128} disabled={blocked || !!operation} value={draft.sourceId} onChange={event => setFiles(files.map((item, at) => at === index ? { ...item, sourceId: event.target.value } : item))} /></Field><Field label={`Report format ${index + 1}`}><Select value={draft.dialect} disabled={blocked || !!operation} onChange={event => setFiles(files.map((item, at) => at === index ? { ...item, dialect: event.target.value as EvidenceDialect } : item))}>{ready.data.capabilities.dialects.map(dialect => <option key={dialect} value={dialect}>{formats[dialect]}</option>)}</Select></Field><Field label={`Shard claim ${index + 1}`} hint="Optional; match a declared expected shard."><Input maxLength={128} disabled={blocked || !!operation} value={draft.shardId} onChange={event => setFiles(files.map((item, at) => at === index ? { ...item, shardId: event.target.value } : item))} /></Field></div></fieldset>)}
        <label className="evidence-checkbox"><input type="checkbox" checked={useRoster} disabled={blocked || !!operation || !ready.data.inventory} onChange={event => setUseRoster(event.target.checked)} />Use the current authorized inventory{ready.data.inventory ? ` revision ${ready.data.inventory.revision}` : " (none declared)"}</label>
        <label className="evidence-checkbox"><input type="checkbox" checked={retainRaw} disabled={blocked || !!operation} onChange={event => setRetainRaw(event.target.checked)} />Retain raw bytes for separate download and reparse</label><p className="team-muted">Default retention keeps normalized observations only. Retaining raw files does not grant a raw download privilege.</p>
        <div className="evidence-actions"><Action primary disabled={blocked || !files.length || !!operation || ready.isFetching} onClick={() => void perform(importFiles, admitted)}>{busy ? "Preparing and uploading…" : "Import reports"}</Action>{busy && <Action onClick={() => { lifetime.current.abort(); lifetime.current = new AbortController(); setBusy(false); setFiles([]); }}>Cancel upload</Action>}
          {operation && <Action disabled={busy} onClick={() => void perform(signal => client.evidence<Receipt>(`${root}/imports?${new URLSearchParams({ operationKey: operation })}`, { signal }), admitted)}>Recover operation</Action>}
          {operation && !active && !busy && <Action onClick={() => { setOperation(""); setJobId(""); setRetainRaw(false); setFiles([]); setNotice("Ready for a distinct new operation."); }}>Start new operation</Action>}
        </div>
      </section> : <p className="team-section team-muted">Viewers can read normalized reports and minimized exports. An editor or admin role is needed to import reports.</p>}
      {job.data && <section className="team-section" aria-label="Evidence operation"><div className="evidence-row"><h2>Import operation</h2>{active && can("import") && <Action disabled={busy} onClick={() => void perform(signal => client.evidence(`${root}/imports/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {}, signal }), () => { void job.refetch(); setNotice("Cancellation requested. Cancelled operations cannot publish later."); })}>Cancel operation</Action>}</div><p role="status">{job.data.job.status}{job.data.job.failureCode ? ` · ${job.data.job.failureCode.split("_").join(" ")}` : ""}</p><p className="team-muted">{active ? "Declared source metadata is not an executed-test result." : job.data.job.status === "completed" ? "The immutable revision is available in this attachment’s saved reports." : "No report was published. The terminal operation remains durable."}</p></section>}
      {report.isPending && chosen && <Loading text="Loading the selected immutable report…" />}
      {view && <><EvidenceReport view={view} /><section className="team-section" aria-label="Evidence export and privacy"><h2>Export and privacy</h2><p className="team-muted">Minimized exports omit leaf names, files, details and raw contents. They retain source identities, coverage and unverified status.</p><div className="evidence-actions">{(["json", "junit", "text"] as const).map(format => <Action key={format} disabled={busy} onClick={() => void perform(signal => client.evidenceBlob(`${setRoot}/export?${new URLSearchParams({ revision: String(view.revision.revision), format })}`, signal), blob => download(blob, `runphantom-evidence-r${view.revision.revision}.${format === "junit" ? "xml" : format === "text" ? "txt" : "json"}`))}>Export {format === "junit" ? "JUnit" : format === "text" ? "text" : "JSON"}</Action>)}</div>
        {can("import") && <Action disabled={blocked || view.sources.some(source => !source.rawAvailable)} onClick={() => void perform(signal => client.evidence<Receipt>(`${setRoot}/reparse`, { method: "POST", body: { expectedRevision: view.revision.revision, operationKey: crypto.randomUUID() }, signal }), admitted)}>Reparse retained bytes</Action>}
        {can("delete") && <div className="evidence-actions"><Action disabled={blocked || !view.sources.some(source => source.rawAvailable)} onClick={() => setConfirm("raw")}>Remove raw bytes</Action><Action disabled={blocked || !view.sources.some(source => source.normalizedAvailable)} onClick={() => setConfirm("normalized")}>Remove normalized content</Action></div>}
        {can("raw_export") && <details><summary>Separate raw download</summary><div className="evidence-details"><p>Raw reports may contain private data absent from minimized exports. Download only a deliberately selected retained source.</p><div className="evidence-grid"><Field label="Raw report source"><Select value={rawSource} disabled={busy} onChange={event => setRawSource(event.target.value)}><option value="">Choose a retained source</option>{view.sources.filter(source => source.rawAvailable).map(source => <option key={source.sourceId} value={source.sourceId}>{source.sourceId}</option>)}</Select></Field><Action disabled={busy || !view.sources.some(source => source.sourceId === rawSource && source.rawAvailable)} onClick={() => void perform(signal => client.evidenceBlob(`${setRoot}/raw/${encodeURIComponent(rawSource)}?revision=${view.revision.revision}`, signal), blob => download(blob, "runphantom-raw-evidence.bin"))}>Download raw report</Action></div></div></details>}
      </section></>}
    </>}
      {authorized && can("delete") && <section className="team-section" aria-label="Clear project external reports"><h2>Clear external reports</h2><p className="team-muted">Remove this project’s external-report history, inventories and retained content; cancel pending report work. Original captured runs, frozen checks and project membership remain.</p><Action disabled={busy} onClick={() => setConfirm("all")}>Clear project external reports</Action></section>}
      {authorized && confirm && <div role="alertdialog" aria-label="Confirm evidence removal" className="team-confirm" onKeyDown={event => { if (event.key === "Escape" && !busy) setConfirm(null); }}><p>{confirm === "all" ? "Clear all external reports and cancel pending report operations in this project?" : `Remove ${confirm === "raw" ? "raw bytes" : "normalized content"} from revision ${view?.revision.revision}? Immutable summaries remain; removed content cannot be recovered.`}</p><div className="evidence-actions"><Action autoFocus disabled={busy} onClick={() => setConfirm(null)}>Keep content</Action><Action disabled={busy} onClick={() => void perform(signal => client.evidence(confirm === "all" ? `${root}/all` : `${setRoot}/retention/${confirm}?revision=${view!.revision.revision}`, { method: "DELETE", signal }), () => { const all = confirm === "all"; setConfirm(null); setRawSource(""); if (all) { setOperation(""); setJobId(""); selectReport(""); setFiles([]); void queries.resetQueries({ queryKey: scope }); } else void report.refetch(); setNotice(all ? "Project external reports cleared." : "Selected retained content removed."); })}>Confirm {confirm === "all" ? "clear external reports" : `remove ${confirm === "raw" ? "raw bytes" : "normalized content"}`}</Action></div></div>}
  </div>;
}
