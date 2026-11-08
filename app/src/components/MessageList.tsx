import { useState } from "react";
import { Chevron } from "./Icons";
import { parseMessages, messagesFromSpan } from "../utils/messageParsing";
import type { Message } from "../utils/messageParsing";

export { parseMessages, messagesFromSpan };

const ROLE_STYLES: Record<string, { bg: string; border: string; text: string; label: string }> = {
  system:    { bg: "var(--rp-surface)", border: "var(--rp-line)", text: "var(--rp-ink)", label: "var(--rp-ink-muted)" },
  user:      { bg: "var(--rp-surface)", border: "var(--rp-wash-border)", text: "var(--rp-ink)", label: "var(--rp-blue)" },
  assistant: { bg: "var(--rp-surface)", border: "var(--rp-line)", text: "var(--rp-ink)", label: "var(--rp-ink-muted)" },
  tool:      { bg: "var(--rp-canvas-blue)", border: "var(--rp-line)", text: "var(--rp-ink)", label: "var(--rp-ink)" },
};

export function MessageImages({ images, outlineColor }: { images: string[]; outlineColor?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((src, i) => {
        const label = `Attached image ${i + 1} of ${images.length}`;
        return (
          <a
            key={i}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${label.toLowerCase()} in a new tab`}
            className="block max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
          >
            <img
              src={src}
              alt={label}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="max-h-64 max-w-full shrink-0 rounded-md object-contain outline outline-1 -outline-offset-1"
              style={outlineColor ? { outlineColor } : undefined}
            />
          </a>
        );
      })}
    </div>
  );
}

function MessageBubble({ msg, defaultExpanded }: { msg: Message; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const style = ROLE_STYLES[msg.role] ?? ROLE_STYLES.system;
  const imageCount = msg.images?.length ?? 0;
  const previewText = msg.content || (imageCount > 0 ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "");
  const preview = previewText.slice(0, 100).replace(/\n/g, " ") + (previewText.length > 100 ? "\u2026" : "");

  return (
    <div className="rp-clipped-ring overflow-hidden rounded-md" style={{ background: style.bg, border: `1px solid ${style.border}` }}>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-250 ease-standard hover:bg-rp-row-hover"
        style={{ borderBottom: expanded ? `1px solid ${style.border}` : "none" }}
        onClick={() => setExpanded(!expanded)}
      >
        <Chevron open={expanded} size={8} />
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em]" style={{ color: style.label }}>
          {msg.role}
        </span>
        {!expanded && (
          <span className="flex-1 truncate text-[12px]" style={{ color: "var(--rp-ink-muted)" }}>{preview}</span>
        )}
        {msg.content.length > 100 && (
          <span className="rp-num ml-auto flex-shrink-0 text-[11px]" style={{ color: "var(--rp-ink-muted)" }}>
            {(msg.content.length / 1000).toFixed(1)}k
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2 select-text cursor-text space-y-2">
          {msg.content && (
            <pre className="text-[13px] leading-relaxed font-sans whitespace-pre-wrap select-text" style={{ color: style.text, userSelect: "text" }}>
              {msg.content}
            </pre>
          )}
          {imageCount > 0 && <MessageImages images={msg.images!} outlineColor={style.border} />}
        </div>
      )}
    </div>
  );
}

export function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div className="space-y-1.5">
      {messages.map((msg, i) => (
        <MessageBubble key={i} msg={msg} defaultExpanded={msg.content.length < 500} />
      ))}
    </div>
  );
}
