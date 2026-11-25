export interface DiffPart {
  kind: "same" | "added" | "removed";
  text: string;
}

/** LCS is O(n·m); beyond this many cells the diff falls back to a whole-text replacement. */
const MAX_CELLS = 4_000_000;
/** Shared runs this short between two changes are folded into one change, as diff-match-patch's semantic cleanup does. */
const MAX_ABSORBED_TOKENS = 2;

/**
 * Words keep their trailing whitespace, so a lone space can never anchor a match between two
 * paraphrases. Leading whitespace becomes its own token so the text rebuilds exactly.
 */
function tokens(text: string): string[] {
  const lead = /^\s+/.exec(text)?.[0];
  const words = text.match(/\S+\s*/g) ?? [];
  return lead ? [lead, ...words] : words;
}

type Op = { kind: DiffPart["kind"]; token: string };

function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length, m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    return [...a.map(token => ({ kind: "removed" as const, token })), ...b.map(token => ({ kind: "added" as const, token }))];
  }
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: "same", token: a[i]! }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) ops.push({ kind: "removed", token: a[i++]! });
    else ops.push({ kind: "added", token: b[j++]! });
  }
  while (i < n) ops.push({ kind: "removed", token: a[i++]! });
  while (j < m) ops.push({ kind: "added", token: b[j++]! });
  return ops;
}

type Segment = { kind: "same"; tokens: string[] } | { kind: "change"; removed: string[]; added: string[] };

function segments(ops: readonly Op[]): Segment[] {
  const out: Segment[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (op.kind === "same") {
      if (last?.kind === "same") last.tokens.push(op.token);
      else out.push({ kind: "same", tokens: [op.token] });
    } else {
      let change = last?.kind === "change" ? last : null;
      if (!change) { change = { kind: "change", removed: [], added: [] }; out.push(change); }
      (op.kind === "removed" ? change.removed : change.added).push(op.token);
    }
  }
  return out;
}

/** Folds short shared runs that sit between two changes into a single change, repeating until stable. */
function absorbShortEqualities(input: Segment[]): Segment[] {
  const out = [...input];
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 1; index < out.length - 1; index++) {
      const left = out[index - 1]!, middle = out[index]!, right = out[index + 1]!;
      if (middle.kind !== "same" || left.kind !== "change" || right.kind !== "change") continue;
      const size = middle.tokens.length;
      const leftSize = Math.max(left.removed.length, left.added.length), rightSize = Math.max(right.removed.length, right.added.length);
      if (size > MAX_ABSORBED_TOKENS || size > leftSize || size > rightSize) continue;
      out.splice(index - 1, 3, {
        kind: "change",
        removed: [...left.removed, ...middle.tokens, ...right.removed],
        added: [...left.added, ...middle.tokens, ...right.added],
      });
      changed = true;
      break;
    }
  }
  return out;
}

/**
 * Word-level diff from `base` to `other`: each change is one "removed" part (only in base)
 * followed by one "added" part (only in other).
 */
export function wordDiff(base: string, other: string): DiffPart[] {
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  for (const segment of absorbShortEqualities(segments(lcsOps(tokens(base), tokens(other))))) {
    if (segment.kind === "same") push("same", segment.tokens.join(""));
    else { push("removed", segment.removed.join("")); push("added", segment.added.join("")); }
  }
  return parts;
}

export function diffStats(parts: readonly DiffPart[]): { added: number; removed: number } {
  const count = (kind: DiffPart["kind"]) => parts.filter(part => part.kind === kind).reduce((sum, part) => sum + (part.text.match(/[^\s]+/g)?.length ?? 0), 0);
  return { added: count("added"), removed: count("removed") };
}
