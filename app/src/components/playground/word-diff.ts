export interface DiffPart {
  kind: "same" | "added" | "removed";
  text: string;
}

const TOKEN = /\s+|[^\s]+/g;
/** LCS is O(n·m); beyond this many cells the diff falls back to a whole-text replacement. */
const MAX_CELLS = 4_000_000;

function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

function push(parts: DiffPart[], kind: DiffPart["kind"], text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/**
 * Word-level diff (longest common subsequence over word and whitespace tokens) from `base` to `other`.
 * "removed" parts exist only in base, "added" parts only in other.
 */
export function wordDiff(base: string, other: string): DiffPart[] {
  const a = tokens(base), b = tokens(other);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const parts: DiffPart[] = [];
  push(parts, "same", a.slice(0, start).join(""));
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    push(parts, "removed", midA.join(""));
    push(parts, "added", midB.join(""));
  } else {
    const n = midA.length, m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { push(parts, "same", midA[i]!); i++; j++; }
      else if (table[i + 1]![j]! >= table[i]![j + 1]!) { push(parts, "removed", midA[i]!); i++; }
      else { push(parts, "added", midB[j]!); j++; }
    }
    while (i < n) push(parts, "removed", midA[i++]!);
    while (j < m) push(parts, "added", midB[j++]!);
  }
  push(parts, "same", a.slice(endA).join(""));
  return parts;
}

export function diffStats(parts: readonly DiffPart[]): { added: number; removed: number } {
  const count = (kind: DiffPart["kind"]) => parts.filter(part => part.kind === kind).reduce((sum, part) => sum + (part.text.match(/[^\s]+/g)?.length ?? 0), 0);
  return { added: count("added"), removed: count("removed") };
}
