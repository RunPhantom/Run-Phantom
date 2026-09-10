import { useState } from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { Streamdown } from "streamdown";
import { Copy, Check } from "lucide-react";
import { C } from "../utils/colors";

const plugins = { cjk, code, math };

function CodeBlock({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const text = typeof children === "string" ? children : "";

  const handleCopy = () => {
    const el = document.createElement("div");
    el.innerHTML = typeof children === "string" ? children : "";
    const raw = el.textContent ?? text;
    navigator.clipboard.writeText(raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden"
      style={{ background: "var(--rp-ink-a04)", border: `1px solid var(--rp-ink-a08)` }}>
      <button
        type="button"
        aria-label={copied ? "Code copied" : "Copy code"}
        className="absolute right-2 top-2 grid min-h-6 min-w-6 place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        style={{ background: "var(--rp-ink-a08)" }}
        onClick={handleCopy}
      >
        {copied ? <Check className="size-3" style={{ color: C.green }} /> : <Copy className="size-3" style={{ color: C.fg1 }} />}
      </button>
      <pre className="p-3 text-[11px] font-mono overflow-auto sb" style={{ color: C.fg3 }} {...props}>
        {children}
      </pre>
    </div>
  );
}

const components = {
  code: ({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) => {
    if (className?.startsWith("language-")) {
      return <code className={className} {...props}>{children}</code>;
    }
    return (
      <code className="px-1 py-0.5 rounded text-[0.9em]"
        style={{ background: "var(--rp-ink-a06)", color: C.fg3 }}
        {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
    <CodeBlock {...props}>{children}</CodeBlock>
  ),
};

const linkSafety = { enabled: true, allowedSchemes: ["http", "https", "mailto"] };

/** Convert self-closing XML tags like <User text="abc" id="xyz"/> to inline code */
function escapeXmlTags(text: string): string {
  return text.replace(/<([A-Z]\w*)\s+[^>]*\/>/g, (match) => `\`${match}\``);
}

export function Markdown({ children }: { children: string }) {
  const cleaned = escapeXmlTags(children);
  return (
    <div className="streamdown">
      <Streamdown
        plugins={plugins}
        linkSafety={linkSafety}
        components={components}
      >
        {cleaned}
      </Streamdown>
    </div>
  );
}
