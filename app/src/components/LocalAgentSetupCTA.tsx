import { useCallback, useMemo, useRef, useState } from "react";
import { Copy, Check, X } from "lucide-react";
import { C } from "../utils/colors";
import { buildSkillPrompt } from "../utils/skill-content";
import { useDialogFocus } from "../hooks/use-dialog-focus";

export interface LocalAgentSetupCTAProps {
  eventName?: string;
  title?: string;
  description?: React.ReactNode;
}

export function LocalAgentSetupCTA({ eventName, title, description }: LocalAgentSetupCTAProps) {
  const cleanName = (eventName ?? "").replace(/^replay:/, "").trim();
  return (
    <InlineSetupCTA eventName={cleanName} title={title} description={description} />
  );
}

function InlineSetupCTA({ eventName, title, description }: { eventName?: string; title?: string; description?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const skillPrompt = useMemo(() => buildSkillPrompt("setup-agent-replay"), []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(skillPrompt);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = skillPrompt;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [skillPrompt]);

  const resolvedTitle = title ?? `Set Up Agent Replay${eventName ? ` for "${eventName}"` : ""}`;
  const resolvedDescription = description ?? "Copy the setup prompt and paste it into your AI coding tool to wire up replay.";

  return (
    <div className="rounded-lg p-3 space-y-2"
      style={{ background: "var(--rp-ink-a04)", border: "1px solid var(--rp-ink-a08)" }}>
      <div className="text-[11px] font-medium" style={{ color: C.fg3 }}>
        {resolvedTitle}
      </div>
      <div className="text-[10px] leading-relaxed" style={{ color: C.fg1 }}>
        {resolvedDescription}
      </div>
      <button
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-[11px] font-medium transition-colors"
        style={{
          background: copied ? "color-mix(in srgb, var(--rp-success) 12%, white 88%)" : "var(--rp-ink-wash)",
          border: `1px solid ${copied ? "color-mix(in srgb, var(--rp-success) 26%, white 74%)" : C.border}`,
          color: copied ? C.green : C.fg3,
        }}
        onClick={copy}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied!" : "Copy Setup Prompt"}
      </button>
    </div>
  );
}

export interface SetupReplayModalProps {
  open: boolean;
  onClose: () => void;
  eventName?: string;
}

export function SetupReplayModal({ open, onClose, eventName }: SetupReplayModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const skillPrompt = useMemo(() => buildSkillPrompt("setup-agent-replay"), []);
  const cleanName = (eventName ?? "").replace(/^replay:/, "").trim();

  useDialogFocus(open, dialogRef, onClose);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(skillPrompt);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = skillPrompt;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [skillPrompt]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="absolute inset-0 bg-[color:var(--rp-scrim)] backdrop-blur-sm"
        style={{ animation: "fade-in 0.15s ease-out forwards" }}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-setup-title"
        className="relative w-full max-w-md mx-4 rounded-xl overflow-hidden"
        style={{
          background: C.surface,
          border: `1px solid ${C.borderLight}`,
          boxShadow: "var(--rp-e4)",
          animation: "dialog-in var(--rp-motion-surface-in) var(--rp-ease-out) forwards",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Close replay setup"
          className="absolute right-3 top-3 p-1.5 rounded-md transition-colors hover:bg-[color:var(--rp-ink-wash)]"
          style={{ color: C.fg1 }}
          onClick={onClose}
        >
          <X className="size-4" />
        </button>

        <div className="p-6 space-y-4">
          <div>
            <h2 id="replay-setup-title" className="text-[15px] font-semibold" style={{ color: C.fg4 }}>
              Set Up Agent Replay
            </h2>
            {cleanName && (
              <div className="text-[12px] mt-1 font-mono" style={{ color: C.fg1 }}>
                for "{cleanName}"
              </div>
            )}
          </div>

          <p className="text-[13px] leading-relaxed" style={{ color: C.fg2 }}>
            Copy this prompt and paste it into Claude Code, Cursor, or another AI coding tool
            in your agent's repo. It will set up the replay endpoint automatically.
          </p>

          <button
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-[13px] font-medium transition-[background-color,border-color,color]"
            style={{
              background: copied ? "color-mix(in oklch, var(--rp-success) 12%, transparent)" : C.accent,
              border: `1px solid ${copied ? "color-mix(in srgb, var(--rp-success) 28%, white 72%)" : C.selectedBorder}`,
              color: copied ? C.green : "var(--rp-canvas)",
            }}
            onClick={copy}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied to clipboard!" : "Copy Setup Prompt"}
          </button>

          <div className="text-[11px] text-center" style={{ color: C.fg0 }}>
            Using Claude Code? Just run <code className="font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--rp-ink-a08)", color: C.fg2 }}>/setup-agent-replay</code>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes dialog-in {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
