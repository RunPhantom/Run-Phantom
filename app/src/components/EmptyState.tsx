import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { C } from "../utils/colors";
import { RunPhantomMark } from "./RunPhantomMark";
import { SignalField } from "./SignalField";

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
    <div className="relative h-full overflow-auto px-6 py-10">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[color:var(--rp-border)]" />
      <div className="relative mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center text-center">
        <div className="mb-5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--rp-ink-muted)]">
          <RunPhantomMark decorative size={19} className="text-[color:var(--rp-ink-strong)]" />
          <span>Run Phantom</span>
        </div>

        <div className="mb-6 rounded-2xl border p-5 shadow-[0_18px_60px_var(--rp-ink-a08)]" style={{ borderColor: C.border, background: C.surface }}>
          <SignalField />
        </div>

        <h1
          className="text-balance text-center text-[clamp(2rem,7vw,3.4rem)] font-semibold leading-[0.98]"
          style={{ fontFamily: "var(--font-display)", letterSpacing: "-0.03em", color: C.fg4 }}
        >
          Run Phantom.<br />Trace with intent.
        </h1>

        <p className="mt-4 text-[15px] font-semibold" style={{ color: C.accent }}>
          See the run. Find the reason.
        </p>

        <p className="mb-6 mt-3 max-w-xl text-center text-[15px] leading-7" style={{ color: C.fg2 }}>
          Instrument a local agent once. Run Phantom streams traces, tool calls, and replay context into a local evidence workspace.
        </p>

        <p className="text-[12px]" style={{ color: C.fg1 }}>
          Paste this command into a supported coding agent, not a terminal.
        </p>
        <CommandPill value={SETUP_COMMAND} large />

        {onSeeDemoTraces && (
          <button
            type="button"
            onClick={handleSeeDemoTraces}
            disabled={demoLoading}
            className="mt-3 min-h-11 text-[14px] font-medium underline underline-offset-4 decoration-[color:var(--rp-border-strong)] transition-[transform,color,text-decoration-color] duration-150 hover:-translate-y-0.5 hover:decoration-[color:var(--rp-accent)] hover:text-[color:var(--rp-ink-strong)] disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
            style={{ color: C.fg2, background: "transparent" }}
          >
            {demoLoading ? "Loading demo traces..." : "Load demo traces"}
          </button>
        )}

        <WorksWith />

        <p className="mt-8 max-w-xl text-center text-sm leading-6" style={{ color: C.fg1 }}>
          Captured data stays local. Exports and provider-backed actions share data only when you invoke them.
        </p>
      </div>
    </div>
  );
}

type Agent = (typeof AGENTS)[number];

function CommandPill({ value, large = false }: { value: string; large?: boolean }) {
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
      className={`group mt-4 inline-flex min-h-11 items-center gap-2 overflow-hidden rounded-full font-mono transition-[transform,background-color,border-color,color,box-shadow] duration-200 hover:-translate-y-0.5 ${
        large ? "px-5 py-2 text-[clamp(0.95rem,4vw,1.125rem)]" : "px-3 py-1 text-[13px]"
      }`}
      style={{
        color: copied ? C.green : C.fg5,
        background: C.elevated,
        border: `1px solid ${C.border}`,
        boxShadow: large ? "0 12px 40px var(--rp-ink-a12)" : "none",
      }}
      title={copied ? "Copied" : "Click to copy"}
      aria-label={`${copied ? "Copied" : "Copy"} setup command ${value}`}
    >
      <span>{value}</span>
      <span
        className={`grid h-5 w-4 place-items-center transition-[opacity,transform] duration-200 ${copied ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`}
        style={{ color: copied ? C.green : C.fg2 }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </span>
    </button>
  );
}

function WorksWith() {
  return (
    <div className="mt-9 flex max-w-xl flex-col items-center gap-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: C.fg1 }}>
        Installer-ready for
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        {AGENTS.map((agent) => (
          <AgentName key={agent.name} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function AgentName({ agent }: { agent: Agent }) {
  const content = (
    <>
      <AgentGlyph agent={agent} />
      <span className="sr-only">{agent.name}</span>
    </>
  );

  if ("localHref" in agent) {
    return (
      <a
        href={agent.localHref}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition hover:-translate-y-0.5"
        style={{ color: C.fg2, background: C.surface, border: `1px solid ${C.border}` }}
        aria-label={`Open ${agent.name}`}
        title={`Open ${agent.name}`}
      >
        {content}
      </a>
    );
  }

  return (
    <span
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full"
      style={{ color: C.fg2, background: C.surface, border: `1px solid ${C.border}` }}
      title={agent.name}
    >
      {content}
    </span>
  );
}

function AgentGlyph({ agent }: { agent: Agent }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 min-w-7 items-center justify-center rounded-full px-1 font-mono text-[9px] font-bold tracking-[-0.04em]"
      style={{ color: C.fg4, background: C.selected }}
    >
      {agent.glyph}
    </span>
  );
}
