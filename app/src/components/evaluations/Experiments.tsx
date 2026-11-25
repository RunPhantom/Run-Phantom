import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DisabledReason, Field, Select } from "./field";
import { ResponseSpanSelect, SnapshotPreview, Verdict, measurement } from "./SnapshotPreview";
import { textareaClass, ruleLabel } from "./RuleEditor";
import { evaluationsApi, type DatasetRevision, type Experiment, type Snapshot, type Comparison, type ExperimentSummary } from "../../api/evaluations";
import { useRuns } from "../../hooks/use-runs";
import { plural } from "../../utils/helpers";
import { ScoreDistribution } from "./ScoreDistribution";
import { JudgeSpendSummary, JudgeUsageLine } from "./JudgeCost";
import { runOptionLabel } from "./EvaluationOverview";
import type { ComparisonRequest } from "./ExperimentIndex";
import { percent } from "./overview-model";

function evidenceValue(value: unknown): string { if (value === null || value === undefined) return "Unavailable"; if (typeof value === "string") return value === "" ? "(Empty text)" : value; return JSON.stringify(value); }

export function startBlocker(revision: DatasetRevision, name: string, assigned: (caseId: string) => boolean, needsConsent: boolean): string | null {
  if (!revision.cases.length) return "Add a case and save a new revision first.";
  const missing = revision.cases.filter(item => !assigned(item.id)).length;
  if (missing) return `Choose a run for ${plural(missing, "more case")}.`;
  if (!name.trim()) return "Name the experiment to start it.";
  if (needsConsent) return "Allow the model grader to receive the run data, or remove the model rubric rule from the dataset.";
  return null;
}

export function StartExperiment({ revision, onStarted }: { revision: DatasetRevision; onStarted: (experiment: Experiment) => void }) {
  const runs = useRuns();
  const reasonId = useId();
  const [name, setName] = useState("");
  const [assignments, setAssignments] = useState<Record<string, { runId: string; outputSpanId: string }>>({});
  const [preview, setPreview] = useState<{ caseId: string; snapshot: Snapshot } | null>(null);
  const [allowModelJudges, setAllowModelJudges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasRubric = revision.cases.some(item => item.rules.some(rule => rule.kind === "rubric"));
  const blocker = startBlocker(revision, name, caseId => !!assignments[caseId]?.runId, hasRubric && !allowModelJudges);
  async function perform(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start experiment."); } finally { setBusy(false); } }
  return <section aria-label="Start experiment" className="space-y-4">
    <p className="text-13 leading-relaxed text-rp-ink-muted">Pick a captured run for each case in revision {revision.version}. Run Phantom grades what each run already recorded and does not rerun your agent. A run is graded only when its input matches the case input.</p>
    {error && <p role="alert" className="text-13 text-rp-danger">{error}</p>}
    <fieldset className="space-y-4" disabled={busy}>
      <Field label="Experiment name"><Input value={name} onChange={event => setName(event.target.value)} maxLength={128} placeholder="Baseline checkout" /></Field>
      {revision.cases.map(item => { const assignment = assignments[item.id] ?? { runId: "", outputSpanId: "" }; return <div key={item.id} className="space-y-3 rounded-md border border-rp-line p-3"><h3 className="text-13 font-semibold">{item.name}</h3><Field label={`Candidate run for ${item.name}`}><Select value={assignment.runId} onChange={event => { setAssignments(previous => ({ ...previous, [item.id]: { runId: event.target.value, outputSpanId: "" } })); setPreview(null); }}><option value="">Choose a captured run</option>{runs.data?.map(run => <option key={run.id} value={run.id}>{runOptionLabel(run)}</option>)}</Select></Field>{assignment.runId && <><ResponseSpanSelect runId={assignment.runId} value={assignment.outputSpanId} label={`Response span for ${item.name}`} onChange={value => { setAssignments(previous => ({ ...previous, [item.id]: { ...assignment, outputSpanId: value } })); setPreview(null); }} /><Button variant="ghost" size="sm" aria-label={`Preview candidate for ${item.name}`} onClick={() => void perform(async () => setPreview({ caseId: item.id, snapshot: await evaluationsApi.snapshot(assignment.runId, assignment.outputSpanId || undefined) }))}>Preview candidate</Button></>}{preview?.caseId === item.id && <SnapshotPreview snapshot={preview.snapshot} title="Candidate snapshot" />}</div>; })}
      {hasRubric && <label className="flex items-start gap-2 text-13 leading-relaxed"><input type="checkbox" className="mt-0.5" checked={allowModelJudges} onChange={event => setAllowModelJudges(event.target.checked)} /><span>Allow model judges to send selected trace data to the chosen providers<span className="mt-1 block text-rp-ink-muted">A model rubric rule sends each run's input and response to OpenAI or Anthropic with your saved key, and you pay for those calls. A model rubric rule counts like any other rule: it passes when the score reaches your passing score, a lower score fails the case, and an unanswered call leaves the case ungraded. You are asked again for every experiment.</span></span></label>}
      <div className="space-y-2"><Button disabled={!!blocker} aria-describedby={blocker ? reasonId : undefined} onClick={() => void perform(async () => { const consent = allowModelJudges; setAllowModelJudges(false); const started = await evaluationsApi.start({ datasetId: revision.datasetId, version: revision.version, name: name.trim(), assignments: revision.cases.map(item => ({ caseId: item.id, runId: assignments[item.id].runId, ...(assignments[item.id].outputSpanId ? { outputSpanId: assignments[item.id].outputSpanId } : {}) })), ...(hasRubric ? { allowModelJudges: consent } : {}) }); onStarted(started); })}>Start experiment</Button><DisabledReason id={reasonId} reason={!busy && blocker} /></div>
    </fieldset>
    {busy && <p role="status" className="text-13">Reading the chosen runs…</p>}
  </section>;
}

const statusWords = { queued: "queued", running: "running", completed: "completed", cancelled: "cancelled" } as const;

export function ExperimentResults({ experimentId }: { experimentId: string }) {
  const experiment = useQuery({ queryKey: ["evaluations", "experiment", experimentId], queryFn: () => evaluationsApi.experiment(experimentId), refetchInterval: query => !query.state.data || ["queued", "running"].includes(query.state.data.status) ? 1000 : false });
  const reviews = useQuery({ queryKey: ["evaluations", "reviews", experimentId], queryFn: () => evaluationsApi.reviews(experimentId) });
  const reviewReason = useId();
  const [caseId, setCaseId] = useState("");
  const [rating, setRating] = useState<"pass" | "fail">("pass");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function perform(work: () => Promise<void>) { setBusy(true); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update experiment."); } finally { setBusy(false); } }
  if (experiment.isLoading) return <p role="status" className="text-13">Loading experiment results…</p>;
  if (experiment.error) return <p role="alert" className="text-13 text-rp-danger">{experiment.error.message}</p>;
  const data = experiment.data;
  if (!data) return null;
  const active = data.status === "queued" || data.status === "running";
  const orderedReviews = [...(reviews.data ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const reviewBlocker = active ? "Wait for the experiment to finish before reviewing it." : !caseId ? "Choose the case you reviewed." : null;
  return <section aria-label="Experiment results" className="rp-fade-rise space-y-4 border-t border-rp-line-muted pt-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">{data.name}</h2><div className="flex items-center gap-3"><span role="status" className="rp-meta capitalize">{statusWords[data.status]}</span><Verdict status={data.verdict} /></div></div>
    <p className="text-13 text-rp-ink-muted">{data.datasetName} · revision {data.datasetVersion} · {data.summary.pass} / {plural(data.summary.total, "case")} passed ({percent(data.summary.passRate)}) · {data.summary.fail} failed · {data.summary.inconclusive} could not be graded.</p>
    {data.results.some(result => result.checks.some(check => check.source === "llm")) && <JudgeSpendSummary spend={data.summary.judgeSpend} />}
    {(error || data.error) && <p role="alert" className="text-13 text-rp-danger">{error || data.error}</p>}
    {notice && <p role="status" className="text-13">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      {(["json", "junit"] as const).map(format => <Button key={format} size="sm" variant="outline" disabled={busy} title="Lists each case result. The report fails unless every case passed. Prompts, responses and grader explanations stay on this machine." onClick={() => void perform(async () => {
        const blob = await evaluationsApi.report(data.id, format);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `evaluation-${data.id}.${format === "junit" ? "junit.xml" : "json"}`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice("Report downloaded. It fails unless every case passed.");
      })}>Download {format === "junit" ? "JUnit" : "JSON"} report</Button>)}
      {active && <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(async () => { await evaluationsApi.cancel(data.id); await experiment.refetch(); setNotice("Cancelling. Checks that already finished keep their result; the rest are marked inconclusive."); })}>Cancel experiment</Button>}
    </div>
    {data.results.map(result => { const latestReview = orderedReviews.find(review => review.caseId === result.caseId); return <article key={result.caseId} aria-label={`${result.caseName}: ${result.status}`} className="space-y-3 border-t border-rp-line pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{result.caseName}</h3><Verdict status={result.status} /></div>
      {result.inputMatch !== "match" && <p className="text-13 text-rp-warning">{result.inputMatch === "mismatch" ? "Input mismatch: candidate and reference inputs differ. No model judge was called for this case." : "Input unavailable: exact comparison is impossible. No model judge was called for this case."}</p>}
      {result.inputMatch !== "match" && <details><summary className="rp-disclosure cursor-pointer text-13">Compare the case input with the run input</summary><dl className="mt-2 space-y-2 text-13"><div><dt className="font-medium">Case input</dt><dd className="whitespace-pre-wrap break-words">{result.case.input ?? "Unavailable"}</dd></div><div><dt className="font-medium">Run input</dt><dd className="whitespace-pre-wrap break-words">{result.snapshot.input ?? "Unavailable"}</dd></div></dl></details>}
      <ol className="space-y-3">{result.checks.map((check, index) => <li key={index} className="space-y-2 rounded-md border border-rp-line p-3 text-13"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium" title={`Evaluator ${check.evaluatorVersion}`}>{check.source === "llm" ? "Model grader" : "Code check"}</span><span className={`font-mono text-11 uppercase tracking-[0.08em] ${check.status === "pass" ? "text-rp-success" : check.status === "fail" ? "text-rp-danger" : "text-rp-warning"}`}>{check.status}</span></div><p className="break-words">{result.case.rules[index] ? ruleLabel(result.case.rules[index]) : "Retained check"}</p><p className="break-words text-rp-ink-muted">{check.reason}</p><p aria-label={check.source === "llm" ? "Model judge score" : "Code check score"}>Score: {measurement(check.score)}</p>{check.source === "llm" && <JudgeUsageLine usage={check.usage} />}{(check.redacted || check.truncated) && <p className="text-rp-warning">{check.redacted ? "Sensitive values were redacted. " : ""}{check.truncated ? "Some expected or actual text was cut short." : ""}</p>}<details><summary className="cursor-pointer">Expected and actual values</summary><dl className="mt-2 space-y-2"><div><dt className="font-medium">Expected</dt><dd className="whitespace-pre-wrap break-words">{evidenceValue(check.expected)}</dd></div><div><dt className="font-medium">Actual</dt><dd className="whitespace-pre-wrap break-words">{evidenceValue(check.actual)}</dd></div></dl></details>{check.spanIds.map((spanId, at) => <Link key={spanId} className="mr-3 inline-block" to={`/runs/${encodeURIComponent(result.runId)}/span/${encodeURIComponent(spanId)}`}>Open step {at + 1}</Link>)}</li>)}</ol>
      <details><summary className="rp-disclosure cursor-pointer text-13">Candidate run details</summary><div className="mt-3"><SnapshotPreview snapshot={result.snapshot} title="Candidate run details" /></div></details>
      <p className="text-13 text-rp-ink-muted">Latest human review: {latestReview ? `${latestReview.rating === "pass" ? "Pass" : "Fail"}${latestReview.note ? ` — ${latestReview.note}` : ""}` : "Not reviewed"}. A human review is kept beside the automatic result and never changes it.</p>
    </article>; })}
    <section aria-label="Human review" className="space-y-3 border-t border-rp-line pt-4"><h3 className="text-sm font-semibold">Human review</h3><p className="text-13 text-rp-ink-muted">Record your own pass or fail with a note. Earlier reviews and automatic results stay as they are.</p><Field label="Review case"><Select value={caseId} onChange={event => setCaseId(event.target.value)}><option value="">Choose a case</option>{data.results.map(result => <option key={result.caseId} value={result.caseId}>{result.caseName}</option>)}</Select></Field><Field label="Human rating"><Select value={rating} onChange={event => setRating(event.target.value as "pass" | "fail")}><option value="pass">Pass</option><option value="fail">Fail</option></Select></Field><Field label="Review note"><textarea className={textareaClass} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></Field><div className="space-y-2"><Button disabled={busy || !!reviewBlocker} aria-describedby={reviewBlocker ? reviewReason : undefined} onClick={() => void perform(async () => { await evaluationsApi.review(data.id, caseId, rating, note); setNote(""); await reviews.refetch(); setNotice("Human review saved. The automatic result is unchanged."); })}>Save human review</Button><DisabledReason id={reviewReason} reason={reviewBlocker} /></div>
      {reviews.error && <p role="alert" className="text-13 text-rp-danger">{reviews.error.message}</p>}
      <details><summary className="rp-disclosure cursor-pointer text-13">Review history ({orderedReviews.length})</summary><ol className="mt-2 space-y-2 text-13">{orderedReviews.map(review => <li key={review.id}><strong>{data.results.find(result => result.caseId === review.caseId)?.caseName ?? "Case"}: {review.rating}</strong> · {new Date(review.createdAt).toLocaleString()}<p className="break-words">{review.note || "No note"}</p></li>)}</ol></details>
    </section>
  </section>;
}

type CaseChange = Comparison["cases"][number]["change"];
const changeLabel: Record<CaseChange, string> = { regression: "Regressions", improvement: "Improvements", unchanged: "Unchanged", inconclusive: "Inconclusive" };

export function compareBlocker(baseline: string, candidate: string): string | null {
  if (!baseline || !candidate) return "Choose a baseline and a candidate experiment.";
  if (baseline === candidate) return "Choose two different experiments.";
  return null;
}

export function CompareExperiments({ experiments, request }: { experiments: ExperimentSummary[]; request?: ComparisonRequest | null }) {
  const reasonId = useId();
  const section = useRef<HTMLElement>(null);
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [filter, setFilter] = useState<CaseChange | "all">("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const completed = experiments.filter(experiment => experiment.status === "completed");
  const generation = useRef(0);
  async function compare(left: string, right: string) {
    const current = ++generation.current;
    setBusy(true); setError(""); setComparison(null);
    try { const result = await evaluationsApi.compare(left, right); if (current === generation.current) setComparison(result); }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "Comparison failed."); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => {
    if (!request) return;
    setBaseline(request.baseline); setCandidate(request.candidate); setFilter(request.filter);
    section.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    void compare(request.baseline, request.candidate);
  }, [request]);
  const blocker = compareBlocker(baseline, candidate);
  const shown = comparison?.cases.filter(item => filter === "all" || item.change === filter) ?? [];
  const name = (id: string) => experiments.find(item => item.id === id)?.name ?? id;
  return <><section ref={section} aria-label="Experiment comparison" className="scroll-mt-6 space-y-4"><h2 className="text-sm font-semibold">Compare experiments</h2><p className="text-13 text-rp-ink-muted">Compare two finished experiments to see which cases got better or worse. They must use the same dataset revision and the same rule versions.</p><div className="grid gap-3 sm:grid-cols-2"><Field label="Compare baseline"><Select value={baseline} disabled={busy} onChange={event => { setBaseline(event.target.value); setComparison(null); setError(""); }}><option value="">Choose baseline</option>{completed.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.datasetVersion}</option>)}</Select></Field><Field label="Compare candidate"><Select value={candidate} disabled={busy} onChange={event => { setCandidate(event.target.value); setComparison(null); setError(""); }}><option value="">Choose candidate</option>{completed.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.datasetVersion}</option>)}</Select></Field></div><div className="space-y-2"><Button disabled={!!blocker || busy} aria-describedby={blocker ? reasonId : undefined} onClick={() => { setFilter("all"); void compare(baseline, candidate); }}>Compare experiments</Button><DisabledReason id={reasonId} reason={blocker} /></div>{error && <p role="alert" className="text-13 text-rp-danger">{error}</p>}{comparison && <div aria-label="Comparison results" className="space-y-3 text-13">
    <p role="status">Regressions: {comparison.summary.regressions} · Improvements: {comparison.summary.improvements} · Unchanged: {comparison.summary.unchanged} · Inconclusive: {comparison.summary.inconclusive}</p>
    <div role="group" aria-label="Show cases" className="evaluation-filter-chips">{(["all", "regression", "improvement", "unchanged", "inconclusive"] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? `All ${comparison.cases.length}` : `${changeLabel[value]} ${comparison.summary[value === "regression" ? "regressions" : value === "improvement" ? "improvements" : value]}`}</button>)}</div>
    <p className="evaluation-meta">{name(comparison.baselineId)} → {name(comparison.candidateId)}. Deltas are candidate minus baseline.</p>
    {!shown.length ? <p className="evaluation-meta">No cases in this group.</p> : <ul className="space-y-3">{shown.map(item => <li key={item.caseId} className="space-y-1 border-b border-rp-line pb-3"><strong>{item.caseName}: {item.change}</strong><p>{item.baseline} → {item.candidate}</p><p className="text-rp-ink-muted">Tokens {measurement(item.deltas.totalTokens)} · Duration {measurement(item.deltas.durationMs, " ms")} · Reported cost {measurement(item.deltas.costUsd, " USD")}</p></li>)}</ul>}
  </div>}</section><ScoreDistribution experiments={experiments} /></>;
}
