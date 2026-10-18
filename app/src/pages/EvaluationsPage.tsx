import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Field, Select } from "../components/verification/PredicateEditor";
import { DatasetEditor } from "../components/evaluations/DatasetEditor";
import { RepeatedTrials } from "../components/evaluations/RepeatedTrials";
import { StartExperiment, ExperimentResults, CompareExperiments } from "../components/evaluations/Experiments";
import { textareaClass } from "../components/evaluations/RuleEditor";
import { evaluationsApi, type DatasetRevision, type Experiment } from "../api/evaluations";
import { LossyJsonNumberError, parseJsonEvidence } from "../../../src/evaluations/json-evidence";
import { ExternalEvidencePanel } from "../components/ExternalEvidencePanel";
import { FindingComparison } from "../components/evaluations/FindingComparison";

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
  const visibleRevision = !selectionError ? revision.data : undefined;
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
  const [selectedExperiment, setSelectedExperiment] = useState("");
  const [portableJson, setPortableJson] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function perform(work: () => Promise<void>) { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not complete this operation."); } finally { busyRef.current = false; setBusy(false); } }
  function saved(next: DatasetRevision) { queryClient.setQueryData(["evaluations", "revision", next.datasetId, next.version], next); selectRevision(next.datasetId, next.version); void queryClient.invalidateQueries({ queryKey: ["evaluations", "datasets"] }); setNotice(`Saved ${next.datasetName}, revision ${next.version}.`); }
  function started(next: Experiment) { queryClient.setQueryData(["evaluations", "experiment", next.id], next); setSelectedExperiment(next.id); void queryClient.invalidateQueries({ queryKey: ["evaluations", "experiments"] }); setNotice(`Experiment ${next.name} started. Results update as checks finish.`); }
  async function importJson(value: string) { if (new TextEncoder().encode(value).byteLength > 2 * 1024 * 1024) throw new Error("Dataset import exceeds 2 MiB."); let parsed: unknown; try { parsed = parseJsonEvidence(value); } catch (cause) { if (cause instanceof LossyJsonNumberError) throw cause; throw new Error("Dataset import is not valid JSON."); } saved(await evaluationsApi.importDataset(parsed)); setPortableJson(""); setNotice("Portable dataset imported. Local source identities were not imported."); }
  const queryError = datasets.error ?? revision.error ?? experiments.error;
  const evidence = params.get("view") === "evidence";
  const findings = params.get("view") === "findings";
  const tabs = <nav aria-label="Evaluation workspaces" className="flex flex-wrap gap-2 px-5 pt-14 sm:px-8 lg:pt-5"><Button aria-current={!evidence && !findings ? "page" : undefined} variant={!evidence && !findings ? "default" : "ghost"} onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.delete("view"); return next; })}>Regression workbench</Button><Button aria-current={evidence ? "page" : undefined} variant={evidence ? "default" : "ghost"} onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set("view", "evidence"); return next; })}>External reports</Button><Button aria-current={findings ? "page" : undefined} variant={findings ? "default" : "ghost"} onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set("view", "findings"); return next; })}>Finding comparison</Button></nav>;
  if (findings) return <>{tabs}<FindingComparison experiments={experiments.isError ? [] : experiments.data ?? []} /></>;
  if (evidence) return <>{tabs}<ExternalEvidencePanel datasets={datasets.isError ? [] : datasets.data ?? []} experiments={experiments.isError ? [] : experiments.data ?? []} /></>;
  return <>{tabs}<div className="mx-auto min-h-full max-w-6xl space-y-7 p-5 pt-6 text-[color:var(--rp-ink)] sm:p-8 sm:pt-6">
    <header className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight text-[color:var(--rp-ink-strong)]" style={{ fontFamily: "var(--font-display)" }}>Evaluations</h1><p className="max-w-2xl text-sm leading-relaxed text-[color:var(--rp-ink-soft)]">Turn captured agent behavior into repeatable regression cases. Compare frozen candidates against the same expectations, then add your own review.</p></header>
    {(error || selectionError || queryError) && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[color:var(--rp-danger)] p-3 text-xs text-[color:var(--rp-danger)]"><span>{error || selectionError || queryError?.message}</span><Button variant="ghost" onClick={() => { setError(""); void queryClient.invalidateQueries({ queryKey: ["evaluations"] }); }}>Refresh evaluations</Button></div>}
    {notice && <p role="status" className="text-xs text-[color:var(--rp-ink-soft)]">{notice}</p>}
    <section aria-label="Datasets" className="space-y-4 border-y border-[color:var(--rp-border)] py-5"><h2 className="text-sm font-semibold">Regression datasets</h2><div className="flex flex-wrap items-end gap-3"><div className="min-w-[200px] flex-1"><Field label="Dataset name"><Input value={datasetName} onChange={event => setDatasetName(event.target.value)} placeholder="Checkout regression cases" maxLength={128} /></Field></div><Button disabled={busy || !datasetName.trim()} onClick={() => void perform(async () => { saved(await evaluationsApi.createDataset(datasetName.trim())); setDatasetName(""); })}>Create dataset</Button></div>
      {datasets.isLoading ? <p role="status" className="text-xs">Loading datasets…</p> : !datasets.data?.length ? <p className="text-xs text-[color:var(--rp-ink-soft)]">No datasets yet. Create one, then add an example from a captured run.</p> : <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]"><Field label="Dataset"><Select value={selectionError ? "" : datasetId} onChange={event => selectRevision(event.target.value)} disabled={busy}>{selectionError && <option value="">Choose an available dataset</option>}{datasets.data.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="Revision"><Select value={selectionError ? "" : selectedVersion ?? dataset?.latestVersion ?? 1} onChange={event => { if (explicitSelection) selectRevision(datasetId, Number(event.target.value)); else setVersion(Number(event.target.value)); }} disabled={busy || !dataset}>{selectionError && <option value="">Choose an available revision</option>}{Array.from({ length: dataset?.latestVersion ?? revision.data?.version ?? 1 }, (_, index) => index + 1).map(item => <option value={item} key={item}>Revision {item}{item === dataset?.latestVersion ? " (latest)" : ""}</option>)}</Select></Field></div>}
      <details><summary className="cursor-pointer text-xs">Import and export datasets</summary><div className="mt-4 space-y-3"><p className="text-xs text-[color:var(--rp-ink-soft)]">Portable JSON contains case names, reference inputs, tags and explicit rules. Import creates a new dataset and drops source run identities.</p><Field label="Dataset JSON"><textarea className={`${textareaClass} min-h-36`} maxLength={2 * 1024 * 1024} value={portableJson} onChange={event => setPortableJson(event.target.value)} /></Field><Field label="Import dataset file"><input type="file" accept=".json,application/json" className="text-xs" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void perform(async () => { if (file.size > 2 * 1024 * 1024) throw new Error("Dataset import exceeds 2 MiB."); setPortableJson(await file.text()); setNotice("Dataset file loaded. Review it, then import JSON."); }); event.target.value = ""; }} /></Field><div className="flex flex-wrap gap-2"><Button disabled={busy || !portableJson.trim()} onClick={() => void perform(() => importJson(portableJson))}>Import JSON</Button><Button variant="outline" disabled={busy || !visibleRevision} onClick={() => void perform(async () => { const exported = await evaluationsApi.exportDataset(datasetId, visibleRevision!.version); const json = JSON.stringify(exported, null, 2); setPortableJson(json); const url = URL.createObjectURL(new Blob([json], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `runphantom-dataset-r${visibleRevision!.version}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("Dataset exported. The portable JSON is available above."); })}>Export selected revision</Button></div></div></details>
    </section>
    {revision.isLoading && datasetId && !selectionError && <p role="status" className="text-xs">Loading dataset revision…</p>}
    {visibleRevision && <div className="flex flex-wrap items-start gap-8"><div className="min-w-0 flex-[1_1_360px]"><DatasetEditor key={`${visibleRevision.datasetId}:${visibleRevision.version}`} revision={visibleRevision} latestVersion={dataset?.latestVersion ?? visibleRevision.version} initialRunId={params.get("runId") ?? ""} onSaved={saved} /></div><div className="min-w-0 flex-[1_1_360px]"><StartExperiment key={`${visibleRevision.datasetId}:${visibleRevision.version}`} revision={visibleRevision} onStarted={started} /></div></div>}
    <section aria-label="Saved experiments" className="space-y-4 border-t border-[color:var(--rp-border)] pt-5"><h2 className="text-sm font-semibold">Experiments and reviews</h2>{experiments.isLoading ? <p role="status" className="text-xs">Loading experiments…</p> : !experiments.data?.length ? <p className="text-xs text-[color:var(--rp-ink-soft)]">Start an experiment to retain automatic results, comparisons and separate human reviews.</p> : <Field label="View experiment"><Select value={selectedExperiment} onChange={event => setSelectedExperiment(event.target.value)}><option value="">Choose an experiment</option>{experiments.data.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status} · r{item.datasetVersion}</option>)}</Select></Field>}{selectedExperiment && <ExperimentResults key={selectedExperiment} experimentId={selectedExperiment} />}</section>
    <CompareExperiments experiments={experiments.data ?? []} />
    <RepeatedTrials experiments={experiments.data ?? []} onOpen={setSelectedExperiment} />
    {datasetId && !selectionError && <details><summary className="cursor-pointer text-xs text-[color:var(--rp-ink-muted)]">Dataset management</summary><div className="mt-3 space-y-2"><p className="text-xs text-[color:var(--rp-ink-soft)]">Deleting this dataset removes its revisions. Frozen experiments and human reviews remain available.</p><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { await evaluationsApi.deleteDataset(datasetId); setSelectedDataset(""); setVersion(undefined); await queryClient.invalidateQueries({ queryKey: ["evaluations"] }); setNotice("Dataset deleted; frozen experiment history is retained."); })}>Delete selected dataset</Button></div></details>}
  </div></>;
}
