import { parseJsonEvidence } from "../json-evidence";
import { ReaderRefusal, type ReaderLimits } from "./limits";

/** Validate the complete JSON grammar before JSON.parse can erase duplicate keys. */
export function strictEvidenceJson(text: string, limits: ReaderLimits): unknown {
  let at = 0, nodes = 0;
  const fail = () => { throw new ReaderRefusal("invalid_json", false); };
  const space = () => { while (/[\x20\t\r\n]/.test(text[at] ?? "!")) at++; };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') {
        try { return JSON.parse(text.slice(start, at)) as string; } catch { return fail(); }
      }
      if (char === "\\") at++;
    }
    return fail();
  }
  function value(depth: number): void {
    if (++nodes > 200_000) throw new ReaderRefusal("source_limit");
    if (depth > limits.maxDepth) throw new ReaderRefusal("depth_exceeded");
    space();
    if (text[at] === '"') { string(); return; }
    if (text[at] === "{") {
      at++; space(); const keys = new Set<string>();
      if (text[at] === "}") { at++; return; }
      while (at < text.length) {
        space(); if (text[at] !== '"') fail();
        const key = string();
        if (keys.has(key)) throw new ReaderRefusal("duplicate_key");
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new ReaderRefusal("invalid_json");
        keys.add(key); space(); if (text[at++] !== ":") fail();
        value(depth + 1); space();
        if (text[at] === "}") { at++; return; }
        if (text[at++] !== ",") fail();
      }
      fail();
    }
    if (text[at] === "[") {
      at++; space(); if (text[at] === "]") { at++; return; }
      while (at < text.length) {
        value(depth + 1); space(); if (text[at] === "]") { at++; return; }
        if (text[at++] !== ",") fail();
      }
      fail();
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!literal) fail();
    at += literal![0].length;
  }
  value(0); space(); if (at !== text.length) fail();
  try { return parseJsonEvidence(text); } catch { return fail(); }
}
