export interface FuzzyMatch {
  score: number;
  /** Indices into the matched text, for highlighting. Empty when a keyword matched instead of the label. */
  indices: number[];
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1]!;
  return /[\s\-_/.:·›]/.test(previous) || (previous === previous.toLowerCase() && text[index] !== text[index]!.toLowerCase());
}

/**
 * Subsequence match with bonuses for consecutive characters, word starts and an
 * early first hit. Returns null when not every query character appears in order.
 * Case-insensitive; whitespace in the query is ignored.
 */
export function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return { score: 0, indices: [] };
  const haystack = text.toLowerCase();
  const contiguous = haystack.indexOf(needle);
  if (contiguous !== -1) {
    const indices = Array.from({ length: needle.length }, (_, offset) => contiguous + offset);
    return { score: 1000 + (isBoundary(text, contiguous) ? 200 : 0) - contiguous - (haystack.length - needle.length) * 0.1, indices };
  }
  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    score += 10;
    if (found === previous + 1) score += 15;
    if (isBoundary(text, found)) score += 20;
    score -= Math.min(found - cursor, 10);
    indices.push(found);
    previous = found;
    cursor = found + 1;
  }
  return { score: score - indices[0]!, indices };
}

/** Best match across a label and its keywords; label matches carry highlight indices. */
export function fuzzyMatchEntry(query: string, label: string, keywords: readonly string[] = []): FuzzyMatch | null {
  const labelMatch = fuzzyScore(query, label);
  let best = labelMatch ? { ...labelMatch, score: labelMatch.score + 5 } : null;
  for (const keyword of keywords) {
    const match = fuzzyScore(query, keyword);
    if (match && (!best || match.score > best.score)) best = { score: match.score, indices: [] };
  }
  return best;
}
