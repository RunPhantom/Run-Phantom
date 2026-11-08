import { useState } from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { Streamdown } from "streamdown";
import { Copy, Check } from "lucide-react";

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
    <div className="group relative my-2 overflow-hidden rounded-sm border border-rp-line bg-rp-canvas-blue">
      <button
        type="button"
        aria-label={copied ? "Code copied" : "Copy code"}
        className="absolute right-2 top-2 grid min-h-7 min-w-7 place-items-center rounded-control border border-rp-line bg-rp-surface opacity-0 transition-[opacity,background-color] duration-250 ease-standard hover:bg-rp-wash focus-visible:opacity-100 group-hover:opacity-100"
        onClick={handleCopy}
      >
        {copied ? <Check aria-hidden="true" className="size-3 text-rp-success" /> : <Copy aria-hidden="true" className="size-3 text-rp-ink-muted" />}
      </button>
      <pre className="sb overflow-auto p-3 font-mono text-[12px] leading-5 text-rp-ink" {...props}>
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
      <code className="rounded-sm border border-rp-line-muted bg-rp-canvas-blue px-1 py-0.5 font-mono text-[0.88em] text-rp-ink"
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
