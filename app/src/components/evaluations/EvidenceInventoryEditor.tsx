import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "../verification/PredicateEditor";
import type { EvidenceExpectedSource, EvidenceInventoryRevision } from "../../api/evaluations";

const blank = (): EvidenceExpectedSource => ({ shardId: "", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } });
export function EvidenceInventoryEditor({ inventory, prospective, busy, onSave }: { inventory: EvidenceInventoryRevision | null; prospective: boolean; busy: boolean; onSave: (revision: number, expected: EvidenceExpectedSource[]) => Promise<boolean> }) {
  const [expected, setExpected] = useState<EvidenceExpectedSource[]>(inventory?.expected ?? [blank()]);
  const [revision, setRevision] = useState(inventory?.revision ?? 0);
  const changed = revision !== (inventory?.revision ?? 0);
  const update = (index: number, next: EvidenceExpectedSource) => setExpected(expected.map((item, at) => at === index ? next : item));
  return <details className="evidence-inventory-editor"><summary>{inventory ? "Edit the expected roster" : "Declare an expected roster"}</summary><div className="evidence-details">
    <p>{prospective ? "Prepare this complete roster before starting an experiment. Later uploads cannot shrink it." : "This is a retrospective declaration for an existing attachment. It cannot prove complete coverage."}</p>
    {changed && <p role="status" className="evidence-reasons">The saved roster changed. Your draft still targets revision {revision}; saving it will be refused.</p>}
    {expected.map((item, index) => <fieldset className="evidence-roster-row" key={index}><legend>Expected source {index + 1}</legend><div className="evidence-grid"><Field label={`Expected shard ${index + 1}`}><Input maxLength={128} value={item.shardId} disabled={busy} onChange={event => update(index, { ...item, shardId: event.target.value })} placeholder="unit-linux" /></Field><Field label={`Expected kind ${index + 1}`}><Select value={item.kind} disabled={busy} onChange={event => update(index, { ...item, kind: event.target.value as EvidenceExpectedSource["kind"] })}><option value="junit">JUnit</option><option value="attestation">Attestation</option><option value="jsonl">DSSE JSONL</option><option value="json">JSON</option></Select></Field></div>
      <details><summary>Optional identity constraints</summary><div className="evidence-grid evidence-details">{(["runnerId", "commit", "sourceSha256"] as const).map(key => <Field key={key} label={`${key === "runnerId" ? "Runner ID" : key === "commit" ? "Commit assertion" : "Source SHA-256"} ${index + 1}`}><Input maxLength={key === "commit" ? 256 : 128} value={item.constraints[key] ?? ""} disabled={busy} onChange={event => update(index, { ...item, constraints: { ...item.constraints, [key]: event.target.value || null } })} /></Field>)}</div></details>
      <Button variant="ghost" disabled={busy || expected.length === 1} onClick={() => setExpected(expected.filter((_, at) => at !== index))}>Remove expected source {index + 1}</Button>
    </fieldset>)}
    <div className="evidence-actions"><Button variant="outline" disabled={busy || expected.length >= 32} onClick={() => setExpected([...expected, blank()])}>Add expected source</Button><Button className="evidence-primary" disabled={busy || expected.some(item => !item.shardId.trim())} onClick={() => void onSave(revision, expected).then(saved => { if (saved) setRevision(revision + 1); })}>Save expected roster</Button>{changed && <Button variant="outline" disabled={busy} onClick={() => { setExpected(inventory?.expected ?? [blank()]); setRevision(inventory?.revision ?? 0); }}>Load current roster</Button>}</div>
  </div></details>;
}
