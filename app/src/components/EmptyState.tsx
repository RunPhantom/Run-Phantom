import { cn } from "@/lib/utils";
import { ConnectAgentPanel } from "./connect/ConnectAgentPanel";
import { TeachingEmptyState } from "./empty/TeachingEmptyState";

type GhostStatus = "ok" | "errors" | "failed" | "running";

/** Illustrative rows for the labelled ghost only; never shown as data. */
const GHOST_ROWS: readonly { name: string; status: GhostStatus; input: string; model: string; duration: string; tokens: string; cost: string; age: string }[] = [
  { name: "code_review_agent", status: "ok", input: "Review PR #842: refactor auth middleware", model: "claude-sonnet-5-5", duration: "6.2s", tokens: "14.2K", cost: "$0.021", age: "2m" },
  { name: "research_agent", status: "running", input: "Current state of M5 chip rumours, last 30 days", model: "gpt-5-mini", duration: "—", tokens: "3.1K", cost: "$0.004", age: "3m" },
  { name: "triage_agent", status: "errors", input: "Export keeps timing out at 30s", model: "claude-haiku-4-5", duration: "5.2s", tokens: "8.8K", cost: "$0.007", age: "6m" },
  { name: "support_bot", status: "failed", input: "Refund order A1005, damaged on arrival", model: "gpt-5-nano", duration: "1.9s", tokens: "2.4K", cost: "$0.001", age: "9m" },
  { name: "planner", status: "ok", input: "Plan the migration to the new billing API", model: "gemini-3.8-flash", duration: "3.4s", tokens: "6.0K", cost: "$0.003", age: "14m" },
  { name: "code_review_agent", status: "ok", input: "Review PR #839: add retry to webhook sender", model: "claude-sonnet-5-5", duration: "7.9s", tokens: "18.5K", cost: "$0.028", age: "21m" },
  { name: "research_agent", status: "ok", input: "Compare three vector databases for 10M rows", model: "gpt-5-mini", duration: "11.4s", tokens: "22.1K", cost: "$0.019", age: "33m" },
  { name: "support_bot", status: "ok", input: "Where is order A1002?", model: "gpt-5-nano", duration: "1.2s", tokens: "1.9K", cost: "$0.001", age: "41m" },
  { name: "triage_agent", status: "ok", input: "Login loop after password reset on Safari", model: "claude-haiku-4-5", duration: "4.7s", tokens: "7.2K", cost: "$0.006", age: "52m" },
  { name: "planner", status: "errors", input: "Split the onboarding epic into tickets", model: "gemini-3.8-flash", duration: "2.8s", tokens: "5.5K", cost: "$0.002", age: "1h" },
  { name: "code_review_agent", status: "ok", input: "Review PR #835: drop the legacy cache", model: "claude-sonnet-5-5", duration: "5.6s", tokens: "12.9K", cost: "$0.019", age: "1h" },
  { name: "research_agent", status: "ok", input: "Summarise this week's incident reports", model: "gpt-5-mini", duration: "9.1s", tokens: "19.4K", cost: "$0.016", age: "2h" },
];

const STATUS: Record<GhostStatus, { label: string; dot: string }> = {
  ok: { label: "Completed", dot: "bg-rp-mark-success" },
  running: { label: "Running", dot: "bg-rp-mark" },
  errors: { label: "With errors", dot: "bg-rp-mark-warning" },
  failed: { label: "Failed", dot: "bg-rp-mark-danger" },
};

const COLUMNS = "minmax(150px,1.1fr) 118px minmax(180px,2fr) 150px 72px 72px 72px 56px";

function RunsGhost() {
  return (
    <div className="overflow-hidden rounded-lg border border-rp-line bg-rp-surface text-13">
      <div className="grid h-8 items-center border-b border-rp-line bg-rp-canvas px-2" style={{ gridTemplateColumns: COLUMNS }}>
        {["Run", "Status", "Input", "Model", "Duration", "Tokens", "Cost", "Age"].map((label, index) => (
          <span key={label} className={cn("rp-type-eyebrow truncate px-2 text-rp-ink-subtle", index >= 4 && "text-right")}>{label}</span>
        ))}
      </div>
      {GHOST_ROWS.map((row, index) => (
        <div key={index} className="grid h-[34px] items-center border-b border-rp-line-muted px-2 last:border-b-0" style={{ gridTemplateColumns: COLUMNS }}>
          <span className="truncate px-2 font-medium text-rp-ink">{row.name}</span>
          <span className="flex items-center gap-1.5 truncate px-2 text-12 text-rp-ink-muted"><span className={cn("size-1.5 shrink-0 rounded-full", STATUS[row.status].dot)} />{STATUS[row.status].label}</span>
          <span className="truncate px-2 text-rp-ink-muted">{row.input}</span>
          <span className="truncate px-2 font-mono text-12 text-rp-ink-muted">{row.model}</span>
          <span className="px-2 text-right font-mono text-12 text-rp-ink">{row.duration}</span>
          <span className="px-2 text-right font-mono text-12 text-rp-ink">{row.tokens}</span>
          <span className="px-2 text-right font-mono text-12 text-rp-ink">{row.cost}</span>
          <span className="px-2 text-right font-mono text-12 text-rp-ink-muted">{row.age}</span>
        </div>
      ))}
    </div>
  );
}

/** First-run state for Runs: a sample of the table behind the connect guide. */
export function EmptyState({ onSeeDemoTraces }: { onSeeDemoTraces?: () => void | Promise<void> }) {
  return (
    <TeachingEmptyState
      ghost={<RunsGhost />}
      eyebrow="Get started / 2 minutes"
      title="No runs captured yet."
      titleId="runs-get-started"
      lede={
        <>
          <span className="block font-medium text-rp-blue">See the run. Find the reason.</span>
          Point your agent at this machine and every run lands in this table, live.
        </>
      }
      className="px-4 pb-6 pt-4 sm:px-6"
      data-runs-empty
    >
      <ConnectAgentPanel compact waitingLabel="Waiting for your first run…" onLoadSamples={onSeeDemoTraces} />
    </TeachingEmptyState>
  );
}
