import { describe, expect, test } from "bun:test";
import { SourceMap } from "node:module";
import { transformSource, runPhantomSourceProvenance } from "../src/verification/build/vite";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const input = `import React from "react";
export function Checkout() {
  const value: string = "unchanged";
  return <button data-testid="pay" onClick={() => value}>{value}</button>;
}
`;
describe("optional source stamps preserve the actual compiler pipeline", () => {
  test("disabled dev instrumentation is an exact no-op; consent and eligibility are explicit", () => {
    expect(transformSource(input, "/repo/src/Checkout.tsx", "/repo", "serve", {})).toBeNull();
    expect(() => transformSource(input, "/repo/src/Checkout.tsx", "/repo", "serve", { enabled: true })).toThrow(/react-dom/);
    for (const id of ["/other/Checkout.tsx", "/repo/node_modules/x.tsx", "/repo/src/a.test.tsx", "/repo/__tests__/a.tsx", "/repo/src/a.tsx?raw", "\0virtual.tsx"]) expect(transformSource(input, id, "/repo", "serve", { enabled: true, renderer: "react-dom" })).toBeNull();
    expect(transformSource("// @runphantom-source-ignore\n" + input, "/repo/src/Checkout.tsx", "/repo", "serve", { enabled: true, renderer: "react-dom" })).toBeNull();
  });
  test("AST stamping retains handlers/JSX and maps an emitted host tag to its original location", () => {
    const output = transformSource(input, "/repo/src/Checkout.tsx", "/repo", "serve", { enabled: true, renderer: "react-dom" })!;
    expect(output.code).toContain('data-runphantom-source="src/Checkout.tsx:4:10"');
    expect(output.code).toContain("onClick={() => value}");
    const line = output.code.split("\n").findIndex(line => line.includes("<button"));
    const column = output.code.split("\n")[line].indexOf("<button");
    const map = JSON.parse(output.map);
    // Compiler maps are relative to the transformed module, not repository root.
    expect(map.sources).toEqual(["Checkout.tsx"]); expect(output.map).not.toContain("/repo/");
    const location = new SourceMap(map).findEntry(line, column);
    expect(location.originalLine).toBe(3); expect(location.originalColumn).toBe(9);
  });
  test("components and custom-renderer intrinsics stay untouched; reserved stale stamps are replaced", () => {
    const output = transformSource('export const x = <><App/><mesh/><group/><text/><line/><audio/><button data-runphantom-source="old.tsx:1:1">Pay</button></>;', "/repo/src/A.tsx", "/repo", "serve", { enabled: true, renderer: "react-dom" })!;
    expect(output.code.match(/data-runphantom-source/g)).toHaveLength(1);
    expect(output.code).not.toContain("old.tsx"); expect(output.code).toContain("<mesh />");
    expect(transformSource('export const x = <><App data-runphantom-source="component-owned"/><mesh data-runphantom-source="renderer-owned"/></>;', "/repo/src/A.tsx", "/repo", "serve", { enabled: true, renderer: "react-dom" })).toBeNull();
    for (const renderer of ["@react-three/fiber", "ink", "@react-pdf/renderer", "react-reconciler"]) expect(transformSource(`import {x} from "${renderer}"; export const y=<button/>;`, "/repo/src/A.tsx", "/repo", "serve", { enabled: true, renderer: "react-dom" })).toBeNull();
  });
  test("production strips only reserved static attributes, retains output, and never emits metadata", () => {
    const output = transformSource('export const x = <button data-testid="pay" data-runphantom-source="src/A.tsx:1:1">Pay</button>;', "/repo/src/A.tsx", "/repo", "build", {})!;
    expect(output.code).not.toContain("data-runphantom-source"); expect(output.code).toContain('data-testid="pay"'); expect(output.code).toContain("Pay"); expect(output.map).not.toContain("/repo/");
    expect(transformSource(input, "/repo/src/Checkout.tsx", "/repo", "build", { enabled: true, renderer: "react-dom" })).toBeNull();
  });
  test("real directory aliases preserve production privacy and map identity with either symlink policy", () => {
    const base = mkdtempSync(path.join(tmpdir(), "rp-source-alias-"));
    const project = path.join(base, "project"); const alias = path.join(base, "alias");
    const stamped = 'export const x = <button data-testid="pay" data-runphantom-source="/private/fixture.tsx:1:1">Pay</button>;';
    try {
      mkdirSync(path.join(project, "src"), { recursive: true });
      writeFileSync(path.join(project, "src/main.tsx"), stamped);
      symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
      const canonicalFile = realpathSync.native(path.join(alias, "src/main.tsx"));
      expect(canonicalFile.replace(/\\/g, "/")).not.toBe(path.join(alias, "src/main.tsx").replace(/\\/g, "/"));
      for (const preserveSymlinks of [false, true]) for (const enabled of [false, true]) {
        const plugin = runPhantomSourceProvenance({ enabled, renderer: "react-dom" });
        let mappingCalls = 0;
        const config = { root: alias, command: "build" as const, resolve: { preserveSymlinks }, build: { rollupOptions: { output: {
          sourcemapExcludeSources: false,
          sourcemapPathTransform(source: string, _map: string) { mappingCalls++; return source; },
        } } } };
        plugin.config(config, { command: "build" }); plugin.configResolved(config);
        const id = preserveSymlinks ? path.join(alias, "src/main.tsx") : canonicalFile;
        const result = plugin.transform(stamped, id);
        expect(result).not.toBeNull(); expect(result!.code).toContain("Pay"); expect(result!.code).toContain('data-testid="pay"');
        expect(result!.code).not.toContain("data-runphantom-source"); expect(result!.code).not.toContain("/private/fixture.tsx");
        const output = config.build.rollupOptions.output; const map = path.join(base, "out.js.map");
        expect(output.sourcemapExcludeSources).toBe(true); expect(output.sourcemapPathTransform(id, map)).toBe("src/main.tsx");
        const external = path.join(base, "outside.tsx"); const anonymous = output.sourcemapPathTransform(external, map);
        expect(anonymous).toMatch(/^anonymous-[a-f0-9]{16}$/); expect(output.sourcemapPathTransform(external, map)).toBe(anonymous);
        expect(mappingCalls).toBe(3); expect(plugin.transform(stamped, external)).toBeNull();
        const oversized = stamped + "/*" + "x".repeat(2 * 1024 * 1024) + "*/";
        expect(() => plugin.transform(oversized, id)).toThrow("Source provenance refused oversized production JSX: src/main.tsx (limit 2097152 characters)");
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test("source exhaustion keeps disabled development and excluded modules exact while production fails closed", () => {
    const oversized = input + "/*" + "x".repeat(2 * 1024 * 1024) + "*/";
    expect(transformSource(oversized, "/repo/src/A.tsx", "/repo", "serve", { enabled: false })).toBeNull();
    expect(transformSource(oversized, "/repo/src/A.tsx", "/repo", "serve", { enabled: true, renderer: "react-dom" })).toBeNull();
    for (const id of ["/elsewhere/A.tsx", "/repo/node_modules/A.tsx", "/repo/src/A.test.tsx", "\0virtual.tsx"]) expect(transformSource(oversized, id, "/repo", "build", { enabled: false })).toBeNull();
    expect(transformSource(oversized, "/repo/src/A.tsx", "/repo", "build", { enabled: false, include: ["other"] })).toBeNull();
    for (const enabled of [true, false]) expect(() => transformSource(oversized, "/repo/src/A.tsx", "/repo", "build", { enabled, renderer: "react-dom" })).toThrow("Source provenance refused oversized production JSX: src/A.tsx (limit 2097152 characters)");
  });

});
