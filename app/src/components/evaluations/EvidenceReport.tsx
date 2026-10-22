import { useState } from "react";
import { Button } from "../ui/button";
import type { EvidenceSetView, EvidenceSourceObservation } from "../../api/evaluations";

const outcome = { reports_pass: "Reports pass", reports_fail: "Reports failure", unknown: "Unknown", no_tests: "No tests" };
const pretty = (value: string) => value.split("_").join(" ");
const count = (value: string | null) => value ?? "Unavailable";

function SourceReport({ source, payload }: { source: EvidenceSourceObservation; payload: EvidenceSetView["sources"][number] }) {
  const [page, setPage] = useState(0), [open, setOpen] = useState(false);
  const leaves = payload.normalized?.leaves ?? [], pages = Math.ceil(leaves.length / 50);
  return <article className="evidence-source" aria-label={`Source ${source.sourceId}`}>
    <div className="evidence-row evidence-source-heading"><div><h3>{source.sourceId}</h3><p className="evidence-meta">{source.dialect} · {source.shardId ? `Shard ${source.shardId}` : "No shard claim"} · {source.byteLength.toLocaleString()} bytes</p></div><span className="evidence-badge">{outcome[source.reportOutcome]}</span></div>
    <dl className="evidence-counts">{(["executed", "passed", "failed", "errored", "skipped", "disabled", "unknown"] as const).map(key => <div key={key}><dt>{key}</dt><dd>{count(source.leafCounts[key])}</dd></div>)}</dl>
    <p className="evidence-meta">Known executed lower bound: {count(source.observedExecutedLowerBound)}. Exact execution remains unavailable when any leaf is unknown.</p>
    <div className="evidence-trust"><span>Report identity asserted: <strong>{source.reportIdentityAsserted ? "Yes" : "No"}</strong></span><span>Commit assertion match: <strong>{source.commitAssertionMatches === null ? "Unavailable" : source.commitAssertionMatches ? "Yes" : "No"}</strong></span><span>Authenticity: <strong>Not checked</strong></span></div>
    <p className="evidence-meta">Parse: {pretty(source.parseState)} · Interpretation: {source.interpretationComplete ? "complete" : "incomplete"} · Counts consistent: {source.countsConsistent === null ? "unavailable" : source.countsConsistent ? "yes" : "no"}</p>
    {!!source.reasonCodes.length && <p className="evidence-reasons">{source.reasonCodes.map(pretty).join(" · ")}</p>}
    <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Source details and observations</summary>{open && <div className="evidence-details">
      <dl className="evidence-identities"><div><dt>Artifact SHA-256</dt><dd>{source.artifactSha256}</dd></div><div><dt>Normalized SHA-256</dt><dd>{source.normalizedSha256}</dd></div><div><dt>Retained content</dt><dd>Raw {payload.rawAvailable ? "available" : "not available"}; normalized {payload.normalizedAvailable ? "available" : "removed"}</dd></div></dl>
      {!!source.reportReferences.length && <ul>{source.reportReferences.map((ref, index) => <li key={index}>{ref.subjectName}: {ref.resolution}{ref.linkedSourceId ? ` → ${ref.linkedSourceId}` : ""}</li>)}</ul>}
      {payload.normalized?.producerCounts && <p>Producer-declared counts (assertions): <code>{JSON.stringify(payload.normalized.producerCounts)}</code></p>}
      {payload.normalized?.attestation && <p>Attestation asserts {payload.normalized.attestation.producerResult ?? "no producer result"}; {payload.normalized.attestation.signatureCount} signature(s), not verified. Its declarations do not prove test execution.</p>}
      {!payload.normalizedAvailable ? <p>Normalized content was removed. The immutable observation summary remains.</p> : !leaves.length ? <p>No classified test leaves are available for this source.</p> : <><ul className="evidence-leaves">{leaves.slice(page * 50, (page + 1) * 50).map(leaf => <li key={leaf.id}><div className="evidence-row"><span>{leaf.name}</span><strong>{leaf.status}</strong></div>{leaf.detail && <pre>{leaf.detail}</pre>}</li>)}</ul>{pages > 1 && <div className="evidence-row"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous observations</Button><span className="evidence-meta">Page {page + 1} of {pages}</span><Button variant="outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next observations</Button></div>}</>}
    </div>}</details>
  </article>;
}

export function EvidenceReport({ view }: { view: EvidenceSetView }) {
  const set = view.revision;
  return <section className="evidence-panel" aria-label="Persisted evidence report">
    <div className="evidence-row"><div><p className="evidence-eyebrow">IMMUTABLE OBSERVATIONS · REVISION {set.revision}</p><h2>What these reports establish</h2></div><span className="evidence-badge">Authenticity not checked</span></div>
    <div className="evidence-coverage"><div><p className="evidence-meta">Expected-source coverage</p><strong>{pretty(set.coverage)}</strong></div><p>{set.inventory ? `${set.inventory.declaration === "prospective" ? "Prospective" : "Retrospective"} inventory revision ${set.inventory.revision}. ${set.inventory.declaration === "retrospective" ? "A roster declared after capture cannot establish complete coverage." : "The declared roster is independent of this upload."}` : "No authorized expected roster was selected. Uploaded files cannot establish full coverage by themselves."}</p></div>
    {(["missing", "extra", "duplicates", "rejected"] as const).map(key => !!set[key].length && <p key={key} className="evidence-reasons"><strong>{pretty(key)}:</strong> {set[key].join(", ")}</p>)}
    {!!set.reasonCodes.length && <p className="evidence-meta">Reasons: {set.reasonCodes.map(pretty).join(" · ")}</p>}
    <p className="evidence-meta">Imported observations are separate from the original check or experiment verdict.</p>
    {set.sources.map(source => <SourceReport key={`${set.id}:${set.revision}:${source.sourceId}`} source={source} payload={view.sources.find(item => item.sourceId === source.sourceId)!} />)}
    <details><summary>Revision provenance</summary><dl className="evidence-identities evidence-details"><div><dt>Set</dt><dd>{set.id}</dd></div><div><dt>Reader / policy</dt><dd>{set.parserVersion} / {set.policyVersion}</dd></div><div><dt>Configuration SHA-256</dt><dd>{set.configurationSha256}</dd></div><div><dt>Revision digest</dt><dd>{set.digest}</dd></div><div><dt>Initial retention</dt><dd>{pretty(set.initialRetention)}</dd></div></dl></details>
  </section>;
}
