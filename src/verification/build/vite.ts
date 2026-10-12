import ts from "typescript";
import { SOURCE_ATTRIBUTE, sourceFile } from "./source";

export interface SourceProvenanceOptions { enabled?: boolean; renderer?: "react-dom"; include?: string[] }
const domTags = new Set("a abbr address article aside b blockquote body br button caption code col colgroup data datalist dd del details dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input label legend li link main mark menu meta meter nav ol optgroup option output p picture pre progress q section select small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul video svg path circle ellipse rect polygon polyline g defs use symbol clipPath linearGradient radialGradient stop foreignObject".split(" "));
const customRenderers = new Set(["@react-three/fiber", "ink", "@react-pdf/renderer", "react-reconciler"]);

function eligible(id: string, root: string): string | null {
  if (id.startsWith("\0") || id.includes("?") || id.includes("#")) return null;
  const file = sourceFile(id, root);
  if (!file || !/\.[jt]sx$/.test(file) || file.split("/").some(segment => segment === "node_modules" || segment === "__tests__") || /\.(?:spec|test)\.[jt]sx$/.test(file)) return null;
  return file;
}

/** Optional source adapter; never injects the SDK, credentials or an absolute root. */
export function transformSource(code: string, id: string, root: string, command: "serve" | "build", options: SourceProvenanceOptions): { code: string; map: string } | null {
  if (command === "serve" && !options.enabled) return null;
  if (command === "serve" && options.renderer !== "react-dom") throw new Error("Source stamping requires explicit renderer: react-dom consent");
  const file = eligible(id, root);
  if (!file || code.length > 2 * 1024 * 1024) return null;
  if (options.include && !options.include.some(path => file === path.replace(/\\/g, "/") || file.startsWith(`${path.replace(/\\/g, "/").replace(/\/$/, "")}/`))) return null;
  if (command === "serve" && ["// @runphantom-source-ignore", "/* @runphantom-source-ignore */"].includes(code.split(/\r?\n/).find(line => line.trim())?.trim() ?? "")) return null;
  const parsed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (command === "serve" && parsed.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && customRenderers.has(statement.moduleSpecifier.text))) return null;
  let changed = false;
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => source => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attributes = node.attributes.properties.filter(attribute => !(ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === SOURCE_ATTRIBUTE));
        changed ||= attributes.length !== node.attributes.properties.length;
        if (command === "serve" && ts.isIdentifier(node.tagName) && domTags.has(node.tagName.text)) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          const attribute = ts.factory.createJsxAttribute(ts.factory.createIdentifier(SOURCE_ATTRIBUTE), ts.factory.createStringLiteral(`${file}:${position.line + 1}:${position.character + 1}`));
          attributes.push(attribute); changed = true;
        }
        const next = ts.factory.updateJsxAttributes(node.attributes, attributes);
        const updated = ts.isJsxOpeningElement(node) ? ts.factory.updateJsxOpeningElement(node, node.tagName, node.typeArguments, next)
          : ts.factory.updateJsxSelfClosingElement(node, node.tagName, node.typeArguments, next);
        return ts.visitEachChild(updated, visit, context);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(source, visit) as ts.SourceFile;
  };
  const output = ts.transpileModule(code, { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve,
    sourceMap: true, inlineSources: false, verbatimModuleSyntax: true,
  }, transformers: { before: [transformer] }, reportDiagnostics: true });
  if (output.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error("Source stamping refused malformed JSX");
  if (!changed || !output.sourceMapText) return null;
  // The compiler emits relative source names; no absolute developer paths or inline source text.
  return { code: output.outputText.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, "\n"), map: output.sourceMapText };
}

export function runPhantomSourceProvenance(options: SourceProvenanceOptions = {}) {
  let root = ""; let command: "serve" | "build" = "serve";
  return { name: "runphantom-source-provenance", enforce: "pre" as const,
    configResolved(config: { root: string; command: "serve" | "build" }) { root = config.root; command = config.command; },
    transform(code: string, id: string) { return transformSource(code, id, root, command, options); },
  };
}
