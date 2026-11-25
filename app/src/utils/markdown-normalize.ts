const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const GLYPH_BULLET = /^(\s*)[•◦▪‣●]\s+/;

/**
 * Models often write "•" bullets on consecutive lines. Markdown treats those as
 * one paragraph joined by soft breaks, so the list collapsed into a run-on line.
 * Rewrite such lines as "-" list items, leaving fenced code untouched.
 */
export function normalizeMarkdownBullets(text: string): string {
  if (!/[•◦▪‣●]/.test(text)) return text;
  let fence: string | null = null;
  return text.split("\n").map(line => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return line;
    }
    return fence === null ? line.replace(GLYPH_BULLET, "$1- ") : line;
  }).join("\n");
}
