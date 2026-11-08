import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
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

function useSetupPromptCopy() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(true);
  const skillPrompt = useMemo(() => buildSkillPrompt("setup-agent-replay"), []);
  useEffect(() => { active.current = true; return () => { active.current = false; clearTimeout(timer.current); }; }, []);
  const copy = useCallback(async () => {
    let success = false;
    try { await navigator.clipboard.writeText(skillPrompt); success = true; }
    catch {
      const focus = document.activeElement as HTMLElement | null;
      const text = document.createElement("textarea");
      text.value = skillPrompt;
      text.style.position = "fixed";
      text.style.left = "-9999px";
      document.body.appendChild(text);
      text.select();
      try { success = document.execCommand("copy"); } catch { /* Browser denied clipboard access. */ }
      finally { text.remove(); focus?.focus(); }
    }
    if (!active.current) return;
    setCopied(success);
    setCopyError(!success);
    clearTimeout(timer.current);
    if (success) timer.current = setTimeout(() => setCopied(false), 1500);
  }, [skillPrompt]);
  return { copied, copyError, copy };
}

function InlineSetupCTA({ eventName, title, description }: { eventName?: string; title?: string; description?: React.ReactNode }) {
  const { copied, copyError, copy } = useSetupPromptCopy();
  const resolvedTitle = title ?? `Set up agent replay${eventName ? ` for "${eventName}"` : ""}`;
  const resolvedDescription = description ?? "Copy the setup prompt and paste it into your AI coding tool to wire up replay.";

  return (
    <div className="space-y-3 rounded-md border border-rp-wash-border bg-rp-wash p-4">
      <div className="text-[13px] font-semibold text-rp-ink">
        {resolvedTitle}
      </div>
      <div className="text-[12px] leading-5 text-rp-ink-muted">
        {resolvedDescription}
      </div>
      <button
        type="button"
        className={cn(
          "flex min-h-[44px] w-full items-center justify-center gap-2 rounded-control border px-3 py-2 text-[13px] font-medium transition-[background-color,border-color,color] duration-250 ease-standard",
          copied ? "border-rp-success-border bg-rp-success-soft text-rp-success" : "rp-primary-control border-rp-blue bg-rp-blue text-white hover:border-rp-blue-hover hover:bg-rp-blue-hover",
        )}
        onClick={copy}
      >
        {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
        {copied ? "Copied" : "Copy setup prompt"}
      </button>
      <p role={copyError ? "alert" : copied ? "status" : undefined} className={cn("text-[12px] leading-relaxed", copyError ? "text-rp-danger" : "text-rp-ink-muted")}>{copyError ? "Clipboard access was denied. Allow clipboard access and try again." : copied ? "Setup prompt copied. Paste it into your coding tool." : "The prompt configures replay in your agent’s repository."}</p>
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
  const { copied, copyError, copy } = useSetupPromptCopy();
  const cleanName = (eventName ?? "").replace(/^replay:/, "").trim();

  useDialogFocus(open, dialogRef, onClose);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="absolute inset-0 bg-[color:var(--rp-scrim-soft)]"
        style={{ animation: "fade-in 0.2s ease-out forwards" }}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-setup-title"
        className="rp-fade-rise relative mx-4 w-full max-w-md overflow-hidden rounded-lg border border-rp-line bg-rp-surface shadow-e4"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Close replay setup"
          className="absolute right-3 top-3 grid size-8 place-items-center rounded-control text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-4" />
        </button>

        <div className="p-6 space-y-4">
          <div>
            <p className="rp-eyebrow mb-2"><span aria-hidden="true" className="rp-eyebrow-marker" />Replay / Setup</p>
            <h2 id="replay-setup-title" className="rp-subsection-title">
              Set up agent replay
            </h2>
            {cleanName && (
              <div className="rp-meta mt-1">
                for "{cleanName}"
              </div>
            )}
          </div>

          <p className="text-[13px] leading-6 text-rp-ink-muted">
            Copy this prompt and paste it into Claude Code, Cursor, or another AI coding tool
            in your agent's repo. It will set up the replay endpoint automatically.
          </p>

          <button
            className={cn(
              "flex min-h-11 w-full items-center justify-center gap-2 rounded-control border px-4 text-[13px] font-medium transition-[background-color,border-color,color] duration-250 ease-standard",
              copied ? "border-rp-success-border bg-rp-success-soft text-rp-success" : "rp-primary-control border-rp-blue bg-rp-blue text-white hover:border-rp-blue-hover hover:bg-rp-blue-hover",
            )}
            onClick={copy}
          >
            {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
            {copied ? "Copied to clipboard" : "Copy setup prompt"}
          </button>
          {copyError && <p role="alert" className="text-[12px] text-rp-danger">Clipboard access was denied. Allow clipboard access and try again.</p>}

          <div className="text-center text-[12px] text-rp-ink-muted">
            Using Claude Code? Just run <code className="rounded-sm border border-rp-line bg-rp-canvas-blue px-1.5 py-0.5 font-mono text-rp-ink">/setup-agent-replay</code>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
