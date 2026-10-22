import ts from "typescript";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
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
  if (!file) return null;
  if (options.include && !options.include.some(path => file === path.replace(/\\/g, "/") || file.startsWith(`${path.replace(/\\/g, "/").replace(/\/$/, "")}/`))) return null;
  if (code.length > 2 * 1024 * 1024) {
    if (command === "build") throw new Error(`Source provenance refused oversized production JSX: ${file} (limit 2097152 characters)`);
    return null;
  }
  if (command === "serve" && ["// @runphantom-source-ignore", "/* @runphantom-source-ignore */"].includes(code.split(/\r?\n/).find(line => line.trim())?.trim() ?? "")) return null;
  const parsed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (command === "serve" && parsed.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && customRenderers.has(statement.moduleSpecifier.text))) return null;
  let changed = false;
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => source => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const stamp = command === "serve" && ts.isIdentifier(node.tagName) && domTags.has(node.tagName.text);
        const attributes = node.attributes.properties.filter(attribute => !(command === "build" || stamp) || !(ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === SOURCE_ATTRIBUTE));
        changed ||= attributes.length !== node.attributes.properties.length;
        if (stamp) {
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
  type MapOutput = { sourcemapExcludeSources?: boolean; sourcemapPathTransform?: (source: string, mapPath: string) => string };
  const privateMap = (output: MapOutput): MapOutput => {
    const previous = output.sourcemapPathTransform;
    return { ...output, sourcemapExcludeSources: true,
      sourcemapPathTransform(source: string, mapPath: string) {
        const mapped = previous ? previous(source, mapPath) : source;
        const absolute = typeof mapped === "string" && !mapped.includes("\0") ? path.resolve(path.dirname(mapPath), mapped) : "";
        const relative = absolute ? sourceFile(absolute, root) : null;
        return relative ?? `anonymous-${createHash("sha256").update(absolute || (typeof mapped === "string" ? mapped : source)).digest("hex").slice(0, 16)}`;
      },
    };
  };
  return { name: "runphantom-source-provenance", enforce: "pre" as const,
    config(config: { build?: { rollupOptions?: { output?: MapOutput | MapOutput[] } } }, environment: { command: "serve" | "build" }) {
      if (environment.command !== "build") return;
      const build = config.build ??= {}; const rollup = build.rollupOptions ??= {};
      rollup.output = Array.isArray(rollup.output) ? rollup.output.map(privateMap) : privateMap(rollup.output ?? {});
    },
    configResolved(config: { root: string; command: "serve" | "build"; resolve?: { preserveSymlinks?: boolean } }) {
      // Match Vite's resolved module identity while honoring explicit symlink preservation.
      root = config.resolve?.preserveSymlinks ? config.root : realpathSync.native(config.root); command = config.command;
    },
    transform(code: string, id: string) { return transformSource(code, id, root, command, options); },
  };
}
