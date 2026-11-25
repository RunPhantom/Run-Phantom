import { expect, test } from "bun:test";
import { normalizeMarkdownBullets } from "../app/src/utils/markdown-normalize";

test("glyph bullets on consecutive lines become a markdown list", () => {
  const research = "Three sources:\n\n• **Bloomberg (May 3):** M5 debuts.\n• **MacRumors (Apr 28):** corroborates.\n  ◦ nested detail\n• **DigiTimes (May 1):** on schedule.";
  expect(normalizeMarkdownBullets(research)).toBe("Three sources:\n\n- **Bloomberg (May 3):** M5 debuts.\n- **MacRumors (Apr 28):** corroborates.\n  - nested detail\n- **DigiTimes (May 1):** on schedule.");
});

test("fenced code, inline bullets and text without glyphs are unchanged", () => {
  const fenced = "```\n• keep me\n```\nA • B\n~~~\n• also kept\n~~~\n• converted";
  expect(normalizeMarkdownBullets(fenced)).toBe("```\n• keep me\n```\nA • B\n~~~\n• also kept\n~~~\n- converted");
  const plain = "1. First\n\n2. Second";
  expect(normalizeMarkdownBullets(plain)).toBe(plain);
});

test("indented code and HTML blocks keep their glyphs while nested list items convert", () => {
  const code = "Example:\n\n    • literal in code\n    • second code line\n\nDone.";
  expect(normalizeMarkdownBullets(code)).toBe(code);
  const tabbed = "Example:\n\n\t• tab-indented code";
  expect(normalizeMarkdownBullets(tabbed)).toBe(tabbed);
  const html = "<div>\n• inside html\n</div>\n\n• after html";
  expect(normalizeMarkdownBullets(html)).toBe("<div>\n• inside html\n</div>\n\n- after html");
  const nested = "• Parent\n    • deep child\n\n    • still in the list";
  expect(normalizeMarkdownBullets(nested)).toBe("- Parent\n    - deep child\n\n    - still in the list");
});
