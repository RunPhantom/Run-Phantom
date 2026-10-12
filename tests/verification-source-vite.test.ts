import { describe, expect, test } from "bun:test";
import { createRequire, SourceMap } from "node:module";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const appRequire = createRequire(path.join(repo, "app/package.json"));
const viteEntry = path.join(path.dirname(appRequire.resolve("vite/package.json")), "dist/node/index.js");
const reactEntry = path.join(path.dirname(appRequire.resolve("@vitejs/plugin-react-swc")), "index.js");
const fixtureToken = "F20_SYNTHETIC_DEV_PAIR_TOKEN_NEVER_A_CREDENTIAL";
const runtimeMarker = "F20_DEV_VERIFICATION_RUNTIME_SENTINEL";
const code = `import { createRoot } from "react-dom/client";
import { useState } from "react";
function Checkout() {
  const [count, setCount] = useState(0);
  return <button data-testid="pay" data-runphantom-source="stale.tsx:1:1" onClick={() => setCount(count + 1)}>Pay {count}</button>;
}
createRoot(document.getElementById("root")!).render(<Checkout/>);
if (import.meta.env.DEV) { globalThis.fixtureToken = "${fixtureToken}"; globalThis.fixtureRuntime = "${runtimeMarker}"; }
`;

// Vite's Node API is exercised in Node, isolated from Bun's test-worker esbuild lifecycle.
async function runVite(mode: "dev" | "multi" | "single-disabled"): Promise<any> {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-source-vite-"));
  const helperDir = mkdtempSync(path.join(repo, ".omx/source-vite-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>');
  writeFileSync(path.join(root, "src/main.tsx"), code);
  try {
    const adapter = path.join(helperDir, "adapter.mjs");
    await new Promise<void>((resolve, reject) => execFile("bun", ["build", path.join(repo, "src/verification/build/vite.ts"), "--target=node", "--format=esm", "--external=typescript", `--outfile=${adapter}`], { cwd: repo, timeout: 25_000 }, (error, _stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()));
    const script = `import path from "node:path";
import * as vite from ${JSON.stringify(viteEntry)};
import react from ${JSON.stringify(reactEntry)};
import { runPhantomSourceProvenance } from ${JSON.stringify(adapter)};
const root = ${JSON.stringify(root)};
const config = { root, configFile: false, logLevel: "silent", plugins: [runPhantomSourceProvenance({ enabled: ${mode !== "single-disabled"}, renderer: "react-dom" }), react()],
 resolve: { alias: ${JSON.stringify({ "react-dom": path.dirname(appRequire.resolve("react-dom/package.json")), react: path.dirname(appRequire.resolve("react/package.json")) })} }, optimizeDeps: { noDiscovery: true } };
let result;
${mode === "dev" ? `const server = await vite.createServer({ ...config, server: { host: "127.0.0.1", port: 0 } });
try { await server.listen(); result = await server.transformRequest("/src/main.tsx"); } finally { await server.close(); }` : `let mappingCalls = 0;
const custom = { format: "es", entryFileNames: "first-[name].js", sourcemapPathTransform(source, map) { mappingCalls++; return path.resolve(path.dirname(map), source); } };
const output = await vite.build({ ...config, build: { write: false, sourcemap: true, rollupOptions: { output: ${mode === "multi" ? '[custom, { format: "es", entryFileNames: "second-[name].js" }]' : "custom"} } } });
result = { bundles: Array.isArray(output) ? output : [output], mappingCalls };`}
process.stdout.write(JSON.stringify({ root, result }));`;
    const raw = await new Promise<string>((resolve, reject) => execFile("node", ["--input-type=module", "-e", script], { cwd: repo, env: { ...process.env, NODE_ENV: mode === "dev" ? "development" : "production" }, timeout: 25_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
    return JSON.parse(raw);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(helperDir, { recursive: true, force: true }); }
}

describe("actual Vite composition and production asset privacy", () => {
  test("real SWC/Vite dev transforms stamp original JSX and preserve composed original position", async () => {
    const { root, result: transformed } = await runVite("dev"); expect(transformed).not.toBeNull();
    expect(transformed.code).toContain('"data-runphantom-source": "src/main.tsx:5:10"');
    const lines = transformed.code.split("\n"); const line = lines.findIndex((value: string) => value.includes('_jsxDEV("button"'));
    expect(line).toBeGreaterThanOrEqual(0);
    const source = new SourceMap(transformed.map).findEntry(line, lines[line].indexOf('_jsxDEV("button"'));
    expect(source.originalLine).toBe(4); expect(source.originalColumn).toBe(9);
    expect(path.resolve(root, "src", source.originalSource)).toBe(path.join(root, "src/main.tsx"));
  }, 30_000);
  for (const mode of ["multi", "single-disabled"] as const) test(`real ${mode} custom-map builds omit source contents without replacing requested maps`, async () => {
    const { root, result: { bundles, mappingCalls } } = await runVite(mode);
    expect(bundles).toHaveLength(mode === "multi" ? 2 : 1); expect(mappingCalls).toBeGreaterThan(0);
    let externalSources: string[] | undefined;
    for (const bundle of bundles) {
      const maps = bundle.output.filter((asset: any) => asset.type === "asset" && asset.fileName.endsWith(".map")); expect(maps.length).toBeGreaterThan(0);
      for (const map of maps) {
        const raw = String(map.source); const parsed = JSON.parse(raw);
        expect(parsed.sources.length).toBeGreaterThan(0); expect(parsed.sourcesContent?.some((value: unknown) => typeof value === "string")).not.toBe(true);
        expect(parsed.sources).toContain("src/main.tsx");
        const anonymous = parsed.sources.filter((source: string) => source.startsWith("anonymous-")).sort();
        expect(anonymous.length).toBeGreaterThan(0);
        if (externalSources) expect(anonymous).toEqual(externalSources); else externalSources = anonymous;
        for (const privateText of [root, "data-runphantom-source", fixtureToken, runtimeMarker, "/Users/", "/private/var/"]) expect(raw).not.toContain(privateText);
        for (const source of parsed.sources) expect(source).not.toMatch(/^\/|^[A-Za-z]:|\.\./);
      }
      const js = bundle.output.filter((asset: any) => asset.type === "chunk").map((asset: any) => asset.code).join("\n");
      expect(js.includes("Pay ")).toBe(true); for (const value of [fixtureToken, runtimeMarker, "data-runphantom-source", root]) expect(js.includes(value)).toBe(false);
    }
  }, 30_000);
});
