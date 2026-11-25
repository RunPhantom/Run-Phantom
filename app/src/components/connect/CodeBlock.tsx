import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyText } from "../run-detail/CopyButton";

type CopyState = "idle" | "copied" | "failed";

function useCopy(code: string) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(code);
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), ok ? 1600 : 4000);
  };
  return { state, copy };
}

const copyButton = "inline-flex shrink-0 items-center gap-1.5 font-mono text-12 text-rp-ink-muted transition-colors duration-fast ease-out hover:bg-rp-row-hover hover:text-rp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)]";

function CopyStatus({ state }: { state: CopyState }) {
  return <span className="sr-only" role="status">{state === "copied" ? "Copied" : state === "failed" ? "The browser blocked the clipboard. Select the text and copy it." : ""}</span>;
}

/**
 * A labelled, copyable command or file. `label` names the copy button ("Copy curl command").
 * `inline` renders one line with an icon button, for a value rather than a program.
 */
export function CodeBlock({ code, label, caption, maxHeight, inline = false, className, ...data }: {
  code: string;
  label: string;
  caption?: string;
  maxHeight?: number;
  inline?: boolean;
  className?: string;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const { state, copy } = useCopy(code);
  const icon = state === "copied" ? <Check aria-hidden="true" className="size-3.5 text-rp-success" /> : <Copy aria-hidden="true" className="size-3.5" />;

  if (inline) {
    return (
      <div className={cn("flex min-w-0 items-stretch overflow-hidden rounded-control border border-rp-line bg-rp-canvas", className)} data-code-block>
        <code tabIndex={0} aria-label={caption} className="min-w-0 flex-1 overflow-x-auto whitespace-pre px-3 py-2.5 font-mono text-12 leading-5 text-rp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)]" {...data}>{code}</code>
        <button type="button" onClick={() => void copy()} aria-label={state === "copied" ? "Copied" : label} title={label}
          className={cn(copyButton, "w-11 justify-center border-l border-rp-line", state === "failed" && "text-rp-danger")}>
          {icon}
        </button>
        <CopyStatus state={state} />
      </div>
    );
  }

  return (
    <figure className={cn("min-w-0 overflow-hidden rounded-control border border-rp-line bg-rp-canvas", className)} data-code-block>
      <figcaption className="flex min-h-9 items-center justify-between gap-2 border-b border-rp-line-muted pl-3">
        <span className="rp-type-eyebrow truncate text-rp-ink-subtle">{caption ?? "Shell"}</span>
        <button type="button" onClick={() => void copy()} aria-label={label}
          className={cn(copyButton, "h-11 px-3 [@media(pointer:fine)]:h-9", state === "copied" && "text-rp-success hover:text-rp-success", state === "failed" && "text-rp-danger hover:text-rp-danger")}>
          {icon}
          {state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : "Copy"}
        </button>
      </figcaption>
      <pre
        tabIndex={0}
        aria-label={caption ?? label}
        className="overflow-auto whitespace-pre px-3 py-2.5 font-mono text-12 leading-5 text-rp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)]"
        style={maxHeight ? { maxHeight } : undefined}
        {...data}
      ><code>{code}</code></pre>
      <CopyStatus state={state} />
    </figure>
  );
}
