import React, { useCallback, useMemo, useState } from "react";
import { CopyButton } from "./run-detail/CopyButton";

const MONO = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace';
const SIZE = 12;
const LH = 1.6;
const ROW_GAP = 2;
const INDENT = 20;

const mono: React.CSSProperties = { fontFamily: MONO, fontSize: SIZE, lineHeight: LH };
const rowButtonStyle: React.CSSProperties = {
  ...mono,
  width: "100%",
  border: 0,
  background: "transparent",
  padding: 0,
  textAlign: "left",
  cursor: "pointer",
};
const inlineButtonStyle: React.CSSProperties = {
  border: 0,
  background: "transparent",
  padding: 0,
  color: "var(--rp-blue)",
  cursor: "pointer",
  fontSize: SIZE - 1,
  marginLeft: 4,
  fontFamily: MONO,
  userSelect: "none",
};

const dc = {
  key: "var(--rp-ink)",
  string: "var(--rp-json-view-string)",
  number: "var(--rp-json-number)",
  boolean: "var(--rp-json-boolean)",
  null: "var(--rp-ink-muted)",
  brace: "var(--rp-ink-muted)",
  comma: "var(--rp-ink-muted)",
  guide: "var(--rp-guide)",
  guideHover: "var(--rp-guide-hover)",
  count: "var(--rp-ink-muted)",
  arrow: "var(--rp-ink-muted)",
  copyFlash: "var(--rp-accent-flash)",
};

const Arrow: React.FC<{ open: boolean }> = ({ open }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={dc.arrow} strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round"
    style={{ display: "inline-block", verticalAlign: "middle", marginRight: 3,
      transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "" }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const Key: React.FC<{ name: string; isIdx?: boolean }> = ({ name, isIdx }) => (
  <span style={{ color: dc.key, fontWeight: isIdx ? 400 : 600, fontFamily: MONO }}>{name}</span>
);

const EXPAND_CAP = 100_000;
const ExpandableString: React.FC<{ value: string }> = ({ value }) => {
  const [expanded, setExpanded] = useState(false);
  // Even the expanded view is capped: a 20MB leaf string would otherwise mount
  // ~20MB of DOM in one commit when "more" is clicked.
  const display = expanded
    ? (value.length > EXPAND_CAP
        ? value.slice(0, EXPAND_CAP) + `\u2026 [truncated \u2014 ${(value.length - EXPAND_CAP).toLocaleString()} more]`
        : value)
    : value.slice(0, 300) + "\u2026";
  return (
    <>
      <span style={{ color: dc.string, fontFamily: MONO }}>&quot;{display}&quot;</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        style={inlineButtonStyle}
        aria-label={expanded ? "Collapse long string" : "Expand long string"}
      >
        {expanded ? "less" : "more"}
      </button>
    </>
  );
};

type NodeProps = { keyName?: string | number; value: unknown; depth: number; maxExpand: number; isLast: boolean; path: string; copyable: boolean };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
export function jsonPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function copyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}

/** Copy controls for one row: hidden until the row is hovered or a control inside it has focus. */
const RowCopy: React.FC<{ path: string; value: unknown }> = ({ path, value }) => (
  <span className="absolute right-0 top-0 flex items-center gap-0.5 rounded-sm bg-rp-surface pl-1 opacity-0 shadow-e1 transition-opacity duration-fast group-hover/json:opacity-100 group-focus-within/json:opacity-100">
    <CopyButton value={path} label={`Copy path ${path}`} title={`Copy path ${path}`} className="h-[20px] min-w-0 px-1 font-mono text-[11px]">path</CopyButton>
    <CopyButton value={() => copyValue(value)} label={`Copy value at ${path}`} title={`Copy value at ${path}`} className="h-[20px] min-w-0 px-1 font-mono text-[11px]">value</CopyButton>
  </span>
);

const JsonNode: React.FC<NodeProps> = ({ keyName, value, depth, maxExpand, isLast, path, copyable }) => {
  const isObj = value !== null && typeof value === "object" && !Array.isArray(value);
  const isArr = Array.isArray(value);
  const expandable = isObj || isArr;
  const [open, setOpen] = useState(depth < maxExpand);
  const trail = isLast ? "" : ",";

  const keyEl = keyName !== undefined ? (
    <>
      <Key name={String(keyName)} isIdx={typeof keyName === "number"} />
      <span style={{ color: dc.brace, fontFamily: MONO }}>: </span>
    </>
  ) : null;

  if (!expandable) {
    let color: string = "var(--rp-ink)";
    let italic = false;
    let display: React.ReactNode;

    if (value === null) { color = dc.null; italic = true; display = "null"; }
    else if (value === undefined) { color = dc.null; italic = true; display = "undefined"; }
    else if (typeof value === "boolean") { color = dc.boolean; display = String(value); }
    else if (typeof value === "number") { color = dc.number; display = String(value); }
    else if (typeof value === "string") {
      color = dc.string;
      display = value.length > 300 ? <ExpandableString value={value} /> : <>&quot;{value}&quot;</>;
    } else { display = String(value); }

    return (
      <div className={copyable ? "group/json relative flex items-start rounded-sm hover:bg-rp-row-hover" : undefined} title={copyable ? path : undefined} style={{ ...mono, paddingLeft: depth * INDENT, wordBreak: "break-word", marginTop: ROW_GAP }}>
        <span className="min-w-0">
          {keyEl}
          <span style={{ color, fontStyle: italic ? "italic" : "normal", fontFamily: MONO }}>{display}</span>
          <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
        </span>
        {copyable && <RowCopy path={path} value={value} />}
      </div>
    );
  }

  const entries: [string | number, unknown][] = isArr
    ? value.map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const br = isArr ? ["[", "]"] : ["{", "}"];
  const n = entries.length;

  if (n === 0) {
    return (
      <div style={{ ...mono, paddingLeft: depth * INDENT }}>
        {keyEl}<span style={{ color: dc.brace, fontFamily: MONO }}>{br[0]}{br[1]}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
      </div>
    );
  }

  if (!open) {
    const collapsedButton = (
      <button
        type="button"
        style={{ ...rowButtonStyle, paddingLeft: depth * INDENT }}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        aria-expanded={false}
        aria-label={`Expand ${keyName === undefined ? "root" : String(keyName)}`}
      >
        <Arrow open={false} />{keyEl}
        <span style={{ color: dc.brace, fontFamily: MONO }}>{br[0]}</span>
        <span style={{ color: dc.count, fontFamily: MONO, fontSize: SIZE - 1, margin: "0 4px" }}>
          {n} {isArr ? (n === 1 ? "item" : "items") : (n === 1 ? "key" : "keys")}
        </span>
        <span style={{ color: dc.brace, fontFamily: MONO }}>{br[1]}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
      </button>
    );
    if (!copyable) return collapsedButton;
    return <div className="group/json relative flex items-start rounded-sm hover:bg-rp-row-hover" title={path}>{collapsedButton}<RowCopy path={path} value={value} /></div>;
  }

  const openButton = (
    <button
      type="button"
      style={{ ...rowButtonStyle, paddingLeft: depth * INDENT }}
      onClick={(e) => { e.stopPropagation(); setOpen(false); }}
      aria-expanded
      aria-label={`Collapse ${keyName === undefined ? "root" : String(keyName)}`}
    >
      <Arrow open />{keyEl}<span style={{ color: dc.brace, fontFamily: MONO }}>{br[0]}</span>
    </button>
  );
  return (
    <div>
      {copyable ? <div className="group/json relative flex items-start rounded-sm hover:bg-rp-row-hover" title={path}>{openButton}<RowCopy path={path} value={value} /></div> : openButton}
      <div style={{ position: "relative" }}>
        <div
          aria-hidden="true"
          style={{ position: "absolute", top: 0, bottom: 0, left: depth * INDENT + 5, width: 8, borderLeft: `1px solid ${dc.guide}` }}
        />
        {entries.map(([k, v], i) => (
          <JsonNode key={typeof k === "number" ? i : k} keyName={k} value={v} depth={depth + 1} maxExpand={maxExpand} isLast={i === n - 1} path={jsonPath(path, k)} copyable={copyable} />
        ))}
      </div>
      <div style={{ ...mono, paddingLeft: depth * INDENT + 10 }}>
        <span style={{ color: dc.brace, fontFamily: MONO }}>{br[1]}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
      </div>
    </div>
  );
};

/** `copyable` adds copy-path and copy-value controls to every row, shown on hover or focus. */
export function JsonView({ data, maxExpand = 3, copyable = false }: { data: unknown; maxExpand?: number; copyable?: boolean }) {
  const parsed = useMemo(() => {
    if (typeof data === "string") { try { return JSON.parse(data); } catch { return data; } }
    return data;
  }, [data]);
  const deepParse = useCallback((v: unknown): unknown => {
    if (typeof v === "string") {
      const s = v.trim();
      if ((s[0] === "{" && s[s.length - 1] === "}") || (s[0] === "[" && s[s.length - 1] === "]")) {
        try { const p = JSON.parse(s); if (p && typeof p === "object") return deepParse(p); } catch {}
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(deepParse);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = deepParse(val);
      return o;
    }
    return v;
  }, []);

  const normalized = useMemo(() => deepParse(parsed), [parsed, deepParse]);

  if (parsed !== null && typeof parsed === "object") {
    return (
      <div style={{ fontFamily: MONO, fontSize: SIZE }} onClick={(e) => e.stopPropagation()}>
        <JsonNode value={normalized} depth={0} maxExpand={maxExpand} isLast path="$" copyable={copyable} />
      </div>
    );
  }

  // A payload that isn't JSON never reaches JsonNode, so neither the object
  // walker's depth cap nor ExpandableString's EXPAND_CAP applies to it. Without
  // this, a plain-text 2MB tool output mounts in full — the same cost those two
  // caps exist to prevent.
  const scalar = String(parsed);
  const scalarDisplay = scalar.length > EXPAND_CAP
    ? scalar.slice(0, EXPAND_CAP) + `\u2026 [truncated \u2014 ${(scalar.length - EXPAND_CAP).toLocaleString()} more; use copy for the full payload]`
    : scalar;

  return (
    <pre style={{ fontFamily: MONO, fontSize: SIZE, color: "var(--rp-ink)", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
      {scalarDisplay}
    </pre>
  );
}
