import React, { useCallback, useMemo, useState } from "react";
import { C } from "../utils/colors";

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const SIZE = 11;
const LH = 1.4;
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
  color: C.accent,
  cursor: "pointer",
  fontSize: SIZE - 1,
  marginLeft: 4,
  fontFamily: MONO,
  userSelect: "none",
};

const dc = {
  key: C.fg3,
  string: "oklch(42% 0.08 54)",
  number: "oklch(47% 0.12 246)",
  boolean: "oklch(41% 0.13 150)",
  null: C.fg0,
  brace: C.fg0,
  comma: C.fg0,
  guide: "var(--rp-guide)",
  guideHover: "var(--rp-guide-hover)",
  count: C.fg0,
  arrow: C.fg1,
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

type NodeProps = { keyName?: string | number; value: unknown; depth: number; maxExpand: number; isLast: boolean };

const JsonNode: React.FC<NodeProps> = ({ keyName, value, depth, maxExpand, isLast }) => {
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
    let color: string = C.fg2;
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
      <div style={{ ...mono, paddingLeft: depth * INDENT, wordBreak: "break-word", marginTop: ROW_GAP }}>
        {keyEl}
        <span style={{ color, fontStyle: italic ? "italic" : "normal", fontFamily: MONO }}>{display}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
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
    return (
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
  }

  return (
    <div>
      <button
        type="button"
        style={{ ...rowButtonStyle, paddingLeft: depth * INDENT }}
        onClick={(e) => { e.stopPropagation(); setOpen(false); }}
        aria-expanded
        aria-label={`Collapse ${keyName === undefined ? "root" : String(keyName)}`}
      >
        <Arrow open />{keyEl}<span style={{ color: dc.brace, fontFamily: MONO }}>{br[0]}</span>
      </button>
      <div style={{ position: "relative" }}>
        <div
          aria-hidden="true"
          style={{ position: "absolute", top: 0, bottom: 0, left: depth * INDENT + 5, width: 8, borderLeft: `1px solid ${dc.guide}` }}
        />
        {entries.map(([k, v], i) => (
          <JsonNode key={typeof k === "number" ? i : k} keyName={k} value={v} depth={depth + 1} maxExpand={maxExpand} isLast={i === n - 1} />
        ))}
      </div>
      <div style={{ ...mono, paddingLeft: depth * INDENT + 10 }}>
        <span style={{ color: dc.brace, fontFamily: MONO }}>{br[1]}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
      </div>
    </div>
  );
};

export function JsonView({ data, maxExpand = 3 }: { data: unknown; maxExpand?: number }) {
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
        <JsonNode value={normalized} depth={0} maxExpand={maxExpand} isLast />
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
    <pre style={{ fontFamily: MONO, fontSize: SIZE, color: C.fg2, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
      {scalarDisplay}
    </pre>
  );
}
