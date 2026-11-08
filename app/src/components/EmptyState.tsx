import { Check, Copy } from "lucide-react";
import { useState } from "react";

const SETUP_COMMAND = "/instrument-agent";

const AGENTS = [
  { name: "Claude Code", glyph: "CC" },
  { name: "Cursor", glyph: "CU", localHref: "cursor://" },
  { name: "Codex", glyph: "CX" },
  { name: "OpenCode", glyph: "OC" },
  { name: "Amp", glyph: "A" },
  { name: "Windsurf", glyph: "WS", localHref: "windsurf://" },
] as const;

interface EmptyStateProps {
  onSeeDemoTraces?: () => void | Promise<void>;
}

export function EmptyState({ onSeeDemoTraces }: EmptyStateProps) {
  const [demoLoading, setDemoLoading] = useState(false);

  async function handleSeeDemoTraces() {
    if (!onSeeDemoTraces || demoLoading) return;
    setDemoLoading(true);
    try {
      await onSeeDemoTraces();
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <div className="h-full overflow-auto border-t border-rp-line px-5 py-10 sm:px-10 sm:py-14">
      <div className="mx-auto flex max-w-2xl flex-col items-start animate-fade-rise">
        <p className="rp-eyebrow" data-tone="accent">
          <span aria-hidden="true" className="rp-eyebrow-marker" />
          Run Phantom / No runs yet
        </p>

        <h1 className="rp-page-title mt-4">No runs captured yet.</h1>

        <p className="mt-3 text-[15px] font-medium text-rp-blue">
          See the run. Find the reason.
        </p>

        <p className="rp-lede mt-2">
          Instrument a local agent once. Run Phantom streams traces, tool calls, and replay context into a local evidence workspace.
        </p>

        <section aria-labelledby="runphantom-setup-step" className="mt-8 w-full rounded-lg border border-rp-line bg-white p-5 sm:p-6">
          <p id="runphantom-setup-step" className="rp-eyebrow">
            <span className="text-rp-blue">01</span> Instrument an agent
          </p>
          <p className="mt-2 text-[13px] leading-[1.7] text-rp-ink-muted">
            Paste this command into a supported coding agent, not a terminal.
          </p>
          <CommandPill value={SETUP_COMMAND} />
          {onSeeDemoTraces && (
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-rp-line pt-5">
              <button
                type="button"
                onClick={handleSeeDemoTraces}
                disabled={demoLoading}
                aria-busy={demoLoading || undefined}
                className="inline-flex h-9 items-center rounded-control border border-rp-line bg-white px-4 text-[13px] font-medium text-rp-ink transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash disabled:cursor-wait disabled:opacity-60"
              >
                {demoLoading ? "Loading demo traces..." : "Load demo traces"}
              </button>
              <span className="text-xs text-rp-ink-muted">Replays three sample runs into this local workspace.</span>
            </div>
          )}
        </section>

        <WorksWith />

        <p className="mt-8 max-w-xl text-[13px] leading-6 text-rp-ink-muted">
          Captured data stays local. Exports and provider-backed actions share data only when you invoke them.
        </p>
      </div>
    </div>
  );
}

type Agent = (typeof AGENTS)[number];

function CommandPill({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="mt-4 flex min-h-11 w-full items-center justify-between gap-3 rounded-control border border-rp-line bg-rp-canvas-blue px-4 py-2 text-left font-mono text-[15px] text-rp-ink transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash"
      title={copied ? "Copied" : "Click to copy"}
      aria-label={`${copied ? "Copied" : "Copy"} setup command ${value}`}
    >
      <span>{value}</span>
      <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] ${copied ? "text-rp-success" : "text-rp-ink-muted"}`}>
        {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}

function WorksWith() {
  return (
    <div className="mt-8 flex flex-col items-start gap-3">
      <p className="rp-eyebrow">Installer-ready for</p>
      <div className="flex flex-wrap items-center gap-2">
        {AGENTS.map((agent) => (
          <AgentName key={agent.name} agent={agent} />
        ))}
      </div>
    </div>
  );
}

const agentTileClass = "inline-flex h-11 items-center gap-2 rounded-control border border-rp-line bg-white px-3 text-[13px] text-rp-ink";

function AgentName({ agent }: { agent: Agent }) {
  const content = (
    <>
      <span aria-hidden="true" className="font-mono text-[10px] font-semibold tracking-[0.08em] text-rp-blue">{agent.glyph}</span>
      <span>{agent.name}</span>
    </>
  );

  if ("localHref" in agent) {
    return (
      <a
        href={agent.localHref}
        className={`${agentTileClass} transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash`}
        aria-label={`Open ${agent.name}`}
        title={`Open ${agent.name}`}
      >
        {content}
      </a>
    );
  }

  return (
    <span className={agentTileClass} title={agent.name}>
      {content}
    </span>
  );
}
