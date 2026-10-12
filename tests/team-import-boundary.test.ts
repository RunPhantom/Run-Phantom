import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "..");

function runtimeImports(file: string): string[] {
  const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const onlyTypes = clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings
        && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every(item => item.isTypeOnly));
      if (!onlyTypes) imports.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause) || !node.exportClause.elements.every(item => item.isTypeOnly)) {
        imports.push(node.moduleSpecifier.text);
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const source = node.arguments[0];
      expect(source && ts.isStringLiteral(source)).toBe(true);
      if (source && ts.isStringLiteral(source)) imports.push(source.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

function resolveImport(source: string, parent: string): string | null {
  if (!source.startsWith(".")) return null;
  const base = path.resolve(path.dirname(parent), source);
  if (/\.(tgz|json)$/.test(base)) return null;
  const found = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Unresolved runtime import ${source} from ${path.relative(root, parent)}`);
  return found;
}

describe("team runtime authority boundary", () => {
  test("the CLI selects its runtime before any static runtime import", () => {
    const file = path.join(root, "src/index.ts");
    const source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    expect(tree.statements.filter(ts.isImportDeclaration)).toHaveLength(0);
    expect(source).toContain('process.argv[2] === "team"');
    expect(runtimeImports(file).sort()).toEqual(["./evaluations/evidence-worker", "./evaluations/evidence-worker-environment", "./local-cli", "./team/cli"]);
  });

  test("bootstrap refusal precedes reader imports without enabling a pre-guard transpiler cache", () => {
    for (const relative of ["src/index.ts", "src/evaluations/evidence-worker.ts", "src/evaluations/evidence-worker-environment.ts"]) {
      expect(statSync(path.join(root, relative)).size).toBeLessThanOrEqual(4096);
    }
    const file = path.join(root, "src/evaluations/evidence-worker.ts"), source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const staticRuntime = tree.statements.filter(ts.isImportDeclaration).filter(node => !node.importClause?.isTypeOnly);
    expect(staticRuntime.map(node => (node.moduleSpecifier as ts.StringLiteral).text)).toEqual(["./evidence-worker-environment"]);
    expect(source.indexOf("import.meta.main && !prepareEvidenceWorkerEnvironment()")).toBeLessThan(source.indexOf('import("./evidence-protocol")'));
    expect(source.indexOf("finishEvidenceWorkerEnvironment()")).toBeGreaterThan(source.indexOf('import("./evidence-reader/limits")'));
    expect(source.indexOf("finishEvidenceWorkerEnvironment()")).toBeLessThan(source.indexOf("Bun.stdin.stream()"));
    const cli = readFileSync(path.join(root, "src/index.ts"), "utf8");
    expect(cli.indexOf("!prepareEvidenceWorkerEnvironment()")).toBeLessThan(cli.indexOf('import("./evaluations/evidence-worker")'));
  });

  test("transitive team imports exclude local machine and provider services", () => {
    const visited = new Set<string>();
    const pending = [path.join(root, "src/team/cli.ts")];
    const forbidden = /^(?:src\/(?:local-cli|server|db|init|uninstall|replay|replay-map|agents-config|active-workspace|secrets|secret-store|claude-cli-chat|codex-cli-chat|runphantom-startup)\.ts|src\/(?:install|mcp)\/.+|src\/evaluations\/(?:service|judge|store|router)\.ts|src\/verification\/(?:service|router)\.ts)$/;
    const violations: string[] = [];
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (forbidden.test(relative)) violations.push(relative);
      for (const source of runtimeImports(file)) {
        if (/^(?:node:)?child_process$/.test(source) && relative !== "src/ui-assets.ts") {
          violations.push(`${relative} imports child_process`);
        }
        const dependency = resolveImport(source, file);
        if (dependency) pending.push(dependency);
      }
    }
    expect(violations).toEqual([]);
    expect(visited.has(path.join(root, "src/team/server.ts"))).toBe(true);
    expect(visited.has(path.join(root, "src/team/store.ts"))).toBe(true);
  });

  test("transitive reader imports stay inside the reviewed pure graph without database, daemon or provider modules", () => {
    const allowed = new Set([
      "src/evaluations/evidence-worker.ts", "src/evaluations/evidence-worker-environment.ts", "src/evaluations/external-evidence.ts", "src/evaluations/evidence-protocol.ts",
      "src/evaluations/evidence-validation.ts", "src/evaluations/json-evidence.ts", "src/evaluations/evidence-reader/json.ts",
      "src/evaluations/evidence-reader/limits.ts", "src/evaluations/evidence-reader/xml.ts",
      "src/verification/serialization.ts", "src/verification/redaction.ts", "src/verification/protocol.ts",
    ]);
    const visited = new Set<string>(), pending = [path.join(root, "src/evaluations/evidence-worker.ts")];
    const violations: string[] = [];
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (!allowed.has(relative)) violations.push(relative);
      for (const source of runtimeImports(file)) {
        const dependency = resolveImport(source, file);
        if (dependency) pending.push(dependency);
        else if (source !== "node:crypto") violations.push(`${relative} imports ${source}`);
      }
    }
    expect(violations).toEqual([]);
    expect([...visited].map(file => path.relative(root, file).split(path.sep).join("/")).sort()).toEqual([...allowed].sort());
  });
});
