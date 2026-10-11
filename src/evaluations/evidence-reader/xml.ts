import { ReaderRefusal, type ReaderLimits } from "./limits";

export interface EvidenceXmlElement { name: string; attributes: Record<string, string>; children: (EvidenceXmlElement | string | { comment: string } | { target: string; data: string })[] }
export const localName = (name: string) => name.slice(name.lastIndexOf(":") + 1);
export const xmlChildren = (node: EvidenceXmlElement): EvidenceXmlElement[] => node.children.filter((child): child is EvidenceXmlElement => typeof child === "object" && "name" in child);

/** Native XML expands entities. Refuse every actual declaration before calling it. */
export function strictEvidenceXml(text: string, limits: ReaderLimits): EvidenceXmlElement {
  let at = 0, depth = 0, nodes = 0, leaves = 0;
  while (at < text.length) {
    if (text[at] !== "<") { at++; continue; }
    if (text.startsWith("<!--", at) || text.startsWith("<![CDATA[", at)) {
      const comment = text.startsWith("<!--", at), end = text.indexOf(comment ? "-->" : "]]>", at + (comment ? 4 : 9));
      if (end < 0) throw new ReaderRefusal("source_unparsed", false);
      at = end + 3; continue;
    }
    if (text.startsWith("<!", at)) throw new ReaderRefusal(text.startsWith("<!DOCTYPE", at) ? "xml_doctype" : "xml_entity");
    if (text.startsWith("<?", at)) {
      const end = text.indexOf("?>", at + 2);
      if (end < 0) throw new ReaderRefusal("source_unparsed", false);
      const declaration = text.slice(at, end + 2);
      if (!/^<\?xml\s/.test(declaration) || text.slice(0, at).trim()) throw new ReaderRefusal("unsupported_schema", false);
      if (!/^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s|\?>)/.test(declaration)) throw new ReaderRefusal("unsupported_schema", false);
      const encoding = /\bencoding\s*=\s*(["'])(.*?)\1/.exec(declaration)?.[2];
      if (encoding && encoding.toLowerCase() !== "utf-8") throw new ReaderRefusal("unsafe_encoding");
      at = end + 2; continue;
    }
    const start = at++;
    let quote = "";
    while (at < text.length) {
      const char = text[at++];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (text[at - 1] !== ">" || quote) throw new ReaderRefusal("source_unparsed", false);
    if (at - start > 16_384) throw new ReaderRefusal("normalization_limit");
    const tag = text.slice(start, at);
    if (tag.startsWith("</")) depth--;
    else {
      if (++nodes > 200_000) throw new ReaderRefusal("source_limit");
      if (/^<(?:[A-Za-z_][\w.-]*:)?testcase(?:\s|\/?>)/.test(tag) && ++leaves > limits.maxLeaves) throw new ReaderRefusal("source_limit");
      if (!/\/\s*>$/.test(tag)) depth++;
    }
    if (depth > limits.maxDepth) throw new ReaderRefusal("depth_exceeded");
  }
  try { return Bun.XML.parse(text, { compact: false }) as EvidenceXmlElement; }
  catch { throw new ReaderRefusal("source_unparsed", false); }
}
