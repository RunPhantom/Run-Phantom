import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { Eyebrow, PageHeader } from "../components/ui/typography";
import { Input } from "../components/ui/input";
import { DisabledReason, Field, Select } from "../components/evaluations/field";
import { DatasetEditor } from "../components/evaluations/DatasetEditor";
import { RepeatedTrials } from "../components/evaluations/RepeatedTrials";
import { StartExperiment, ExperimentResults, CompareExperiments } from "../components/evaluations/Experiments";
import { textareaClass } from "../components/evaluations/RuleEditor";
import { evaluationsApi, type DatasetRevision, type Experiment } from "../api/evaluations";
import { LossyJsonNumberError, parseJsonEvidence } from "../../../src/evaluations/json-evidence";
import { ExternalEvidencePanel } from "../components/ExternalEvidencePanel";
import { FindingComparison } from "../components/evaluations/FindingComparison";
import { EvaluationNavigation } from "../components/evaluations/EvaluationNavigation";
import { ExperimentIndex, type ComparisonRequest } from "../components/evaluations/ExperimentIndex";
import { DatasetsTable, EvaluationKpis, PassRateHistogram, runOutcome } from "../components/evaluations/EvaluationOverview";
import { EvaluationsEmptyState } from "../components/evaluations/EvaluationsEmptyState";
import { useRuns } from "../hooks/use-runs";
import { ago, plural, runDisplayName } from "../utils/helpers";
import { getRunRow } from "../api/runs";
import { useReturnFocus } from "../hooks/use-return-focus";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export function EvaluationsPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const datasets = useQuery({ queryKey: ["evaluations", "datasets"], queryFn: evaluationsApi.datasets });
  const experiments = useQuery({ queryKey: ["evaluations", "experiments"], queryFn: evaluationsApi.experiments, refetchInterval: 1500 });
  const [selectedDataset, setSelectedDataset] = useState("");
  const [version, setVersion] = useState<number | undefined>();
  const explicitSelection = params.has("datasetId") || params.has("version");
  const datasetValues = params.getAll("datasetId"), versionValues = params.getAll("version");
  const linkedDataset = datasetValues[0] ?? "", linkedVersion = versionValues[0] ?? "";
  const validSelection = datasetValues.length === 1 && versionValues.length === 1
    && linkedDataset.length > 0 && linkedDataset.length <= 128 && !linkedDataset.includes(String.fromCharCode(0))
    && /^[1-9]\d*$/.test(linkedVersion) && Number.isSafeInteger(Number(linkedVersion));
  const datasetId = explicitSelection ? validSelection ? linkedDataset : "" : selectedDataset || datasets.data?.[0]?.id || "";
  const selectedVersion = explicitSelection ? validSelection ? Number(linkedVersion) : undefined : version;
  const dataset = datasets.data?.find(item => item.id === datasetId);
  const revision = useQuery({ queryKey: ["evaluations", "revision", datasetId, selectedVersion], queryFn: () => evaluationsApi.revision(datasetId, selectedVersion), enabled: !!datasetId && (!explicitSelection || !!dataset), refetchOnMount: explicitSelection ? "always" : true });
  const selectionError = explicitSelection && !validSelection ? "Invalid dataset revision link. Choose a dataset and revision to continue."
    : explicitSelection && !datasets.isLoading && !datasets.error && !dataset ? "Selected dataset is unavailable or was deleted. Choose another dataset to continue."
      : explicitSelection && revision.isError ? "Selected dataset revision is unavailable. Choose an existing revision to continue." : "";
  const visibleRevision = !selectionError && !datasets.isError && !revision.isError ? revision.data : undefined;
  const datasetSection = useRef<HTMLElement>(null);
  function selectRevision(id: string, nextVersion?: number) {
    setSelectedDataset(id); setVersion(nextVersion);
    if (explicitSelection) {
      const nextParams = new URLSearchParams(params);
      nextParams.set("datasetId", id);
      nextParams.set("version", String(nextVersion ?? datasets.data?.find(item => item.id === id)?.latestVersion ?? 1));
      setParams(nextParams);
    }
  }
  const [datasetName, setDatasetName] = useState("");
  const linkedRunId = params.get("runId") ?? "";
  const runs = useRuns();
  const listedRun = runs.data?.find(item => item.id === linkedRunId);
  const fetchedRun = useQuery({ queryKey: ["evaluations", "linked-run", linkedRunId], enabled: !!linkedRunId && runs.isSuccess && !listedRun,
    queryFn: ({ signal }) => getRunRow(linkedRunId, signal), staleTime: Infinity, retry: false });
  const linkedRun = listedRun ?? fetchedRun.data ?? undefined;
  const linkedRunName = linkedRun ? runDisplayName(linkedRun) : linkedRunId.slice(0, 12);
  const [nameTouched, setNameTouched] = useState(false);
  const seededName = useRef("");
  const defaultName = linkedRun ? `${runDisplayName(linkedRun)} regression cases`.slice(0, 128) : "";
  useEffect(() => {
    // Offer a ready dataset name once per linked run; a later refetch must not refill a cleared field.
    if (!defaultName || nameTouched || seededName.current === linkedRunId) return;
    seededName.current = linkedRunId;
    setDatasetName(defaultName);
  }, [defaultName, linkedRunId, nameTouched]);
  const [selectedExperiment, setSelectedExperiment] = useState("");
  const [portableJson, setPortableJson] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [experimentOpen, setExperimentOpen] = useState(false);
  const [compareRequest, setCompareRequest] = useState<ComparisonRequest | null>(null);
  const busyRef = useRef(false);
  const createFocus = useReturnFocus(), experimentFocus = useReturnFocus();
  const openCreate = () => { setError(""); createFocus.remember(); setCreateOpen(true); };
  const createReason = useId(), createDialogReason = useId(), experimentReason = useId(), importReason = useId();
  async function perform(work: () => Promise<void>) { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not complete this operation."); } finally { busyRef.current = false; setBusy(false); } }
  function saved(next: DatasetRevision) { queryClient.setQueryData(["evaluations", "revision", next.datasetId, next.version], next); selectRevision(next.datasetId, next.version); void queryClient.invalidateQueries({ queryKey: ["evaluations", "datasets"] }); setNotice(`Saved ${next.datasetName}, revision ${next.version}.`); }
  function started(next: Experiment) { queryClient.setQueryData(["evaluations", "experiment", next.id], next); setSelectedExperiment(next.id); setExperimentOpen(false); void queryClient.invalidateQueries({ queryKey: ["evaluations", "experiments"] }); setNotice(`Experiment ${next.name} started. Results fill in as each check finishes.`); }
  async function importJson(value: string) { if (new TextEncoder().encode(value).byteLength > MAX_IMPORT_BYTES) throw new Error("Dataset import exceeds 2 MiB."); let parsed: unknown; try { parsed = parseJsonEvidence(value); } catch (cause) { if (cause instanceof LossyJsonNumberError) throw cause; throw new Error("Dataset import is not valid JSON."); } saved(await evaluationsApi.importDataset(parsed)); setPortableJson(""); setCreateOpen(false); setNotice("Portable dataset imported. Local source identities were not imported."); }
  async function createDataset() { saved(await evaluationsApi.createDataset(datasetName.trim())); setDatasetName(""); setCreateOpen(false); }
  const queryError = datasets.error ?? revision.error ?? experiments.error;
  const evidence = params.get("view") === "evidence";
  const findings = params.get("view") === "findings";
  const tabs = <EvaluationNavigation active={findings ? "findings" : evidence ? "evidence" : "regression"} onView={view => setParams(previous => { const next = new URLSearchParams(previous); if (view === "regression") next.delete("view"); else next.set("view", view); return next; })} />;
  const upstreamError = (datasets.error || experiments.error) && <p role="alert" className="evaluation-upstream-error">{datasets.error?.message || experiments.error?.message}. Some evaluation context is unavailable. Refresh this page to try again.</p>;
  const caseForm = useRef("");
  const historicalSelection = !!visibleRevision && !!dataset && visibleRevision.version < dataset.latestVersion;
  useEffect(() => {
    // A run opened with "Evaluate run" lands on the case form once, with its snapshot already loading.
    if (!linkedRunId || !visibleRevision || historicalSelection || caseForm.current === linkedRunId) return;
    caseForm.current = linkedRunId;
    requestAnimationFrame(() => document.getElementById("new-case")?.scrollIntoView({ block: "start" }));
  }, [linkedRunId, visibleRevision, historicalSelection]);
  if (findings) return <>{tabs}{upstreamError}<FindingComparison experiments={experiments.isError ? [] : experiments.data ?? []} /></>;
  if (evidence) return <>{tabs}{upstreamError}<ExternalEvidencePanel datasets={datasets.isError ? [] : datasets.data ?? []} experiments={experiments.isError ? [] : experiments.data ?? []} /></>;

  const experimentList = experiments.isError ? [] : experiments.data ?? [];
  const hasDatasets = !!datasets.data?.length;
  const emptyWorkspace = datasets.isSuccess && !hasDatasets && experiments.isSuccess && !experimentList.length && !linkedRunId;
  const createBlocker = !datasetName.trim() ? "Name the dataset to create it." : null;
  const experimentBlocker = !visibleRevision ? "Choose a dataset first."
    : historicalSelection ? "Select the latest revision to start an experiment."
      : !visibleRevision.cases.length ? "Add a case and save a new revision first." : null;
  const openDataset = (id: string) => { selectRevision(id); datasetSection.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); };
  const nameField = <Field label="Dataset name"><Input value={datasetName} onChange={event => { setNameTouched(true); setDatasetName(event.target.value); }} placeholder="Checkout regression cases" maxLength={128} /></Field>;
  const createButton = (reasonId: string) => <div className="space-y-2"><Button disabled={busy || !!createBlocker} aria-describedby={createBlocker ? reasonId : undefined} onClick={() => void perform(createDataset)}>Create dataset</Button><DisabledReason id={reasonId} reason={!busy && createBlocker} /></div>;

  return <>{tabs}<div className="evaluation-workspace">
    <PageHeader eyebrow="Evaluations" title="Evaluations" description={hasDatasets || experimentList.length ? undefined : "Turn captured runs into test cases, grade new runs against them and see what changed."} actions={<>
      <Button variant="outline" disabled={datasets.isFetching || experiments.isFetching} onClick={() => void queryClient.invalidateQueries({ queryKey: ["evaluations"] })}>Refresh</Button>
      {!emptyWorkspace && <Button onClick={openCreate}><Plus aria-hidden="true" />New dataset</Button>}
    </>} />
    {((error && !createOpen) || selectionError || queryError) && <div role="alert" className="evaluation-alert"><span>{(!createOpen && error) || selectionError || queryError?.message}</span><Button variant="destructive-outline" size="sm" onClick={() => { setError(""); void queryClient.invalidateQueries({ queryKey: ["evaluations"] }); }}>Refresh evaluations</Button></div>}
    {notice && <p role="status" className="evaluation-notice">{notice}</p>}
    {linkedRunId && <section aria-label="Run to evaluate" className="evaluation-linked-run">
      <div className="min-w-0 flex-1"><Eyebrow marker tone="accent">Evaluate run</Eyebrow><h2 className="mt-2">Add <span title={linkedRunId}>{linkedRunName}</span> to a dataset as a test case</h2>
        {linkedRun && <p className="evaluation-meta">{[linkedRun.model, runOutcome(linkedRun), `started ${ago(linkedRun.started_at)}`].filter(Boolean).join(" · ")} · <Link to={`/runs/${encodeURIComponent(linkedRunId)}`}>Open run</Link></p>}
        <p>{hasDatasets ? `It is preselected as the source run of a new case in ${visibleRevision?.datasetName ?? "the dataset below"}. Add what a good result looks like, then save a new revision.` : "Create a dataset first. The case form then opens with this run already chosen as its source."}</p></div>
      <Button variant="ghost" size="icon-sm" className="evaluation-linked-run-dismiss" aria-label="Dismiss" onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.delete("runId"); return next; })}><X aria-hidden="true" /></Button>
      {hasDatasets ? <a className="evaluation-linked-run-action" href="#new-case">Go to the case form</a>
        : !datasets.isLoading && !datasets.isError && <div className="evaluation-linked-run-form">{nameField}{createButton(createReason)}</div>}
    </section>}
    {datasets.isLoading ? <p role="status" className="evaluation-meta">Loading datasets…</p>
      : datasets.isError ? <p className="evaluation-meta">Datasets are unavailable. Refresh evaluations to try again.</p>
        : emptyWorkspace ? <EvaluationsEmptyState onCreate={openCreate} />
          : !hasDatasets && !experimentList.length ? null
          : <><EvaluationKpis datasets={datasets.data ?? []} experiments={experimentList} /><div className="evaluation-overview-grid">
            <section aria-labelledby="evaluation-datasets-title" className="evaluation-panel">
              <div className="evaluation-panel-head"><h2 id="evaluation-datasets-title">Datasets</h2><span className="evaluation-meta">{plural(datasets.data?.length ?? 0, "dataset")}</span></div>
              {hasDatasets ? <DatasetsTable datasets={datasets.data ?? []} experiments={experimentList} selectedId={selectionError ? "" : datasetId} onOpen={openDataset} /> : <p className="evaluation-empty-note">Every dataset was deleted. Experiments that used them are still listed below.</p>}
            </section>
            <PassRateHistogram experiments={experimentList} />
          </div></>}
    {(hasDatasets || experimentList.length > 0) && <section aria-label="Saved experiments" className="evaluation-panel space-y-4">
      <div className="evaluation-panel-head"><h2>Experiments</h2>{experiments.data && <span className="evaluation-meta">Each row compares with the previous finished experiment on the same revision.</span>}</div>
      {experiments.isLoading ? <p role="status" className="evaluation-meta">Loading experiments…</p> : experiments.isError ? <p className="evaluation-meta">Experiments are unavailable. Refresh evaluations to try again.</p> : !experimentList.length ? <p className="evaluation-empty-note">No experiments yet. Add cases to a dataset, then choose New experiment to grade captured runs against them.</p> : <><ExperimentIndex experiments={experimentList} selectedId={selectedExperiment} onOpen={setSelectedExperiment} onCompare={(baseline, candidate, filter) => setCompareRequest({ baseline, candidate, filter, nonce: Date.now() })} /><Field label="View experiment"><Select value={selectedExperiment} onChange={event => setSelectedExperiment(event.target.value)}><option value="">Choose an experiment</option>{experimentList.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status} · r{item.datasetVersion}</option>)}</Select></Field></>}
      {selectedExperiment && !experiments.isError && <ExperimentResults key={selectedExperiment} experimentId={selectedExperiment} />}
    </section>}
    {hasDatasets && <section ref={datasetSection} aria-label="Selected dataset" className="evaluation-panel scroll-mt-6 space-y-4">
      <div className="evaluation-panel-head"><h2>{visibleRevision ? visibleRevision.datasetName : "Dataset"}</h2>
        <div className="evaluation-panel-actions"><Button variant="outline" disabled={busy || !visibleRevision} onClick={() => void perform(async () => { const exported = await evaluationsApi.exportDataset(datasetId, visibleRevision!.version); const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `runphantom-dataset-r${visibleRevision!.version}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("Dataset exported. Source run links are left out so the file works in another workspace."); })}>Export selected revision</Button>
          <Button disabled={!!experimentBlocker} aria-describedby={experimentBlocker ? experimentReason : undefined} onClick={() => { experimentFocus.remember(); setExperimentOpen(true); }}>New experiment</Button></div>
      </div>
      <DisabledReason id={experimentReason} reason={experimentBlocker} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]"><Field label="Dataset"><Select value={selectionError ? "" : datasetId} onChange={event => selectRevision(event.target.value)} disabled={busy}>{selectionError && <option value="">Choose an available dataset</option>}{datasets.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="Revision"><Select value={selectionError ? "" : selectedVersion ?? dataset?.latestVersion ?? 1} onChange={event => { if (explicitSelection) selectRevision(datasetId, Number(event.target.value)); else setVersion(Number(event.target.value)); }} disabled={busy || !dataset}>{selectionError && <option value="">Choose an available revision</option>}{Array.from({ length: dataset?.latestVersion ?? revision.data?.version ?? 1 }, (_, index) => index + 1).map(item => <option value={item} key={item}>Revision {item}{item === dataset?.latestVersion ? " (latest)" : ""}</option>)}</Select></Field></div>
      {visibleRevision && <div className="evaluation-revision-context" aria-label="Selected dataset revision"><strong>{visibleRevision.datasetName}</strong><span>Revision {visibleRevision.version}{visibleRevision.version === dataset?.latestVersion ? " · Latest" : dataset && visibleRevision.version < dataset.latestVersion ? " · Historical" : ""}</span><span className="evaluation-meta">{plural(visibleRevision.cases.length, "saved case")}</span></div>}
      {revision.isLoading && datasetId && !selectionError && <p role="status" className="evaluation-meta">Loading dataset revision…</p>}
      {visibleRevision && <div className="evaluation-cases"><DatasetEditor key={`${visibleRevision.datasetId}:${visibleRevision.version}`} revision={visibleRevision} latestVersion={dataset?.latestVersion ?? visibleRevision.version} initialRunId={linkedRunId} onSaved={saved} /></div>}
      {datasetId && !selectionError && <details className="evaluation-management"><summary>Delete this dataset</summary><div className="mt-2 space-y-3"><p className="evaluation-meta">Deleting removes every revision of this dataset. Experiments that used it, and their human reviews, stay available.</p><Button variant="destructive-outline" disabled={busy} onClick={() => void perform(async () => { await evaluationsApi.deleteDataset(datasetId); setSelectedDataset(""); setVersion(undefined); await queryClient.invalidateQueries({ queryKey: ["evaluations"] }); setNotice("Dataset deleted. Its experiments are still listed."); })}>Delete selected dataset</Button></div></details>}
    </section>}
    {(hasDatasets || experimentList.length > 0) && <div className="evaluation-analysis-grid"><CompareExperiments experiments={experimentList} request={compareRequest} /><RepeatedTrials experiments={experimentList} onOpen={setSelectedExperiment} /></div>}
  </div>
    <Dialog open={createOpen} onOpenChange={open => { if (!busy) setCreateOpen(open); }}>
      <DialogContent title="New dataset" description="A dataset holds test cases built from captured runs. Name it now and add cases next." className="max-w-xl" onCloseAutoFocus={createFocus.onCloseAutoFocus}>
        <div className="evaluation-dialog-body mt-5 space-y-4">
          {nameField}
          {createButton(createDialogReason)}
          <details className="border-t border-rp-line-muted pt-2"><summary>Import a dataset file instead</summary><div className="mt-3 space-y-4"><p className="evaluation-meta">Use a JSON file exported from Run Phantom. It brings case names, inputs, tags and rules; links to runs in the other workspace are left out.</p><Field label="Import dataset file"><input type="file" accept=".json,application/json" className="text-xs" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void perform(async () => { if (file.size > MAX_IMPORT_BYTES) throw new Error("Dataset import exceeds 2 MiB."); setPortableJson(await file.text()); }); event.target.value = ""; }} /></Field><Field label="Dataset JSON"><textarea className={`${textareaClass} min-h-36`} maxLength={MAX_IMPORT_BYTES} value={portableJson} onChange={event => setPortableJson(event.target.value)} /></Field><div className="space-y-2"><Button variant="outline" disabled={busy || !portableJson.trim()} aria-describedby={!portableJson.trim() ? importReason : undefined} onClick={() => void perform(() => importJson(portableJson))}>Import JSON</Button><DisabledReason id={importReason} reason={!busy && !portableJson.trim() && "Choose a file or paste the dataset JSON."} /></div></div></details>
          {error && <p role="alert" className="text-13 text-rp-danger">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={experimentOpen} onOpenChange={setExperimentOpen}>
      <DialogContent title="New experiment" description={visibleRevision ? `${visibleRevision.datasetName} · revision ${visibleRevision.version} · ${plural(visibleRevision.cases.length, "case")}` : undefined} className="max-w-2xl" onCloseAutoFocus={experimentFocus.onCloseAutoFocus}>
        <div className="evaluation-dialog-body mt-5">{visibleRevision && <StartExperiment key={`${visibleRevision.datasetId}:${visibleRevision.version}`} revision={visibleRevision} onStarted={started} />}</div>
      </DialogContent>
    </Dialog>
  </>;
}
