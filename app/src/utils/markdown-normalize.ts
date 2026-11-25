const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const GLYPH_BULLET = /^(\s*)[•◦▪‣●]\s+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const HTML_BLOCK_START = /^\s{0,3}<[A-Za-z!/?]/;

const indentWidth = (line: string) => {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
};

/**
 * Models often write "•" bullets on consecutive lines. Markdown treats those as
 * one paragraph joined by soft breaks, so the list collapsed into a run-on line.
 * Rewrite such lines as "-" list items, leaving code and HTML blocks untouched:
 * fenced code, lines inside an HTML block, and lines indented four or more
 * columns outside a list (CommonMark indented code).
 */
export function normalizeMarkdownBullets(text: string): string {
  if (!/[•◦▪‣●]/.test(text)) return text;
  let fence: string | null = null;
  let html = false;
  let list = false;
  return text.split("\n").map(line => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return line;
    }
    if (fence !== null) return line;
    if (!line.trim()) { html = false; return line; }
    if (html || HTML_BLOCK_START.test(line)) { html = true; return line; }
    const indent = indentWidth(line);
    const next = indent < 4 || list ? line.replace(GLYPH_BULLET, "$1- ") : line;
    if (LIST_ITEM.test(next)) list = true;
    else if (indent < 2) list = false;
    return next;
  }).join("\n");
}
