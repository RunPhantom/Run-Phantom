import type { CapturedGuardEvidence, GuardReason } from "../../../src/guard-evidence-protocol";
import "./GuardDecisions.css";

const reasonLabels: Record<GuardReason, string> = {
  source_receipt_missing: "Source receipt unavailable", source_receipt_invalid: "Invalid source receipt withheld", source_receipt_oversized: "Oversized source receipt withheld",
  exporter_loss_unknown: "Exporter event loss is unknown", exporter_events_dropped: "Exporter dropped events", exporter_attributes_unknown: "Exporter attribute loss is unknown",
  exporter_attributes_dropped: "Exporter dropped attributes", receiver_events_dropped: "Receiver omitted events", receiver_attributes_dropped: "Receiver omitted attributes",
  receiver_values_truncated: "Receiver truncated values", receiver_values_invalid: "Receiver withheld invalid values", capture_redacted: "Credential content was redacted",
  source_index_unknown: "Original event position is unknown", event_time_unknown: "Producer event time is unknown", field_missing: "Fields are missing", field_duplicate: "Duplicate fields are ambiguous",
  field_invalid: "Fields are invalid", field_truncated: "Display text was bounded", producer_error: "Producer error reported", public_decisions_omitted: "Some decisions exceed display limits",
};
const stateLabels = { captured: "Captured observations", partial: "Partial capture", unknown: "Capture unknown", "not-captured": "No guard events captured" };
const count = (value: number | null) => value === null ? "unknown" : String(value);

export function GuardDecisions({ evidence }: { evidence?: CapturedGuardEvidence }) {
  return <section className="guard-decisions" aria-label="Captured guard decisions">
    <div className="guard-decisions-heading"><h3>Captured guard decisions</h3><span>{evidence ? stateLabels[evidence.state] : "Capture unknown"}</span></div>
    <p className="guard-decisions-note">Captured producer actions are advisory. Execution coverage is unknown, including when an allow action followed a fail-open error.</p>
    {!evidence ? <p className="guard-decisions-note">Source receipt unavailable.</p> : <>
      <p className="guard-decisions-counts">{evidence.counts.visibleDecisions} of {evidence.counts.capturedDecisions} decisions displayed · Exporter dropped {count(evidence.counts.exporterDroppedEvents)} events · Receiver omitted {evidence.counts.receiverDroppedEvents} events{evidence.counts.omittedDecisions > 0 ? ` · ${evidence.counts.omittedDecisions} decisions omitted from display` : ""}</p>
      {evidence.reasons.length > 0 && <p className="guard-decisions-note" data-testid="guard-capture-reasons">{evidence.reasons.map(reason => reasonLabels[reason]).join(" · ")}</p>}
      {evidence.decisions.length === 0 && <p className="guard-decisions-note">No retained guard decision can be displayed. This provides no evidence of guard completion.</p>}
      <ol className="guard-decisions-list">{evidence.decisions.map(decision => <li key={decision.receiptEventIndex}>
        <details className="guard-decision" data-testid="guard-decision">
          <summary>
            <span className="guard-decision-title">{decision.name ?? "Guard name unknown"}<span>{decision.phase === "unknown" ? "Phase unknown" : decision.phase}</span></span>
            <span className="guard-decision-action" data-action={decision.action}>{decision.action === "unknown" ? "Action unknown" : `Reported ${decision.action}`}</span>
          </summary>
          <div className="guard-decision-body">
            {decision.error === true && <p className="guard-decision-error">Producer error reported</p>}
            <dl><div><dt>Score</dt><dd>{count(decision.score)}</dd></div><div><dt>Latency</dt><dd>{decision.latencyMs === null ? "unknown" : `${decision.latencyMs} ms`}</dd></div>
              <div><dt>Source event index</dt><dd>{count(decision.sourceEventIndex)}</dd></div><div><dt>Receipt event index</dt><dd>{decision.receiptEventIndex}</dd></div>
              <div className="guard-decision-wide"><dt>Producer time (Unix ns)</dt><dd>{decision.timeUnixNano ?? "unknown"}</dd></div>
              <div className="guard-decision-wide"><dt>Classification</dt><dd>{decision.classification === null ? "unknown" : decision.classification || "Empty producer value"}</dd></div>
              {decision.error !== null && <div><dt>Producer error flag</dt><dd>{String(decision.error)}</dd></div>}</dl>
            <p className="guard-decision-explanation">{decision.explanation === null ? "Explanation unavailable" : decision.explanation || "Empty producer explanation"}</p>
            {decision.fieldIssues.length > 0 && <ul className="guard-decision-issues">{decision.fieldIssues.map(issue => <li key={`${issue.field}:${issue.reason}`}>{issue.field}: {reasonLabels[issue.reason]}</li>)}</ul>}
            <p className="guard-decisions-note">{decision.state === "reported" ? "Producer observation retained; execution coverage unknown." : decision.reasons.map(reason => reasonLabels[reason]).join(" · ")}</p>
          </div>
        </details>
      </li>)}</ol>
    </>}
  </section>;
}
