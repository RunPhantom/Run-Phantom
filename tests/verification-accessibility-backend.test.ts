import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { browserDaemon, isReaped } from "./helpers/trusted-browser-daemon";
import { ACCESSIBILITY_FIXTURE_HTML } from "./helpers/accessibility-fixture";
import { accessibilityRuntime } from "./helpers/accessibility-runtime";
import { BROWSER_LIMITS } from "../src/verification/browser-contract";

const installed = process.env.RUNPHANTOM_TEST_BROWSER_MODULE;
const rules = ["button-name", "image-alt", "label", "color-contrast"];
async function withDaemon(callback: (daemon: Awaited<ReturnType<typeof browserDaemon>>, origin: string, runtime: ReturnType<typeof accessibilityRuntime>) => Promise<void>, hold = false) {
  const profile = mkdtempSync(path.join(tmpdir(), "rp-accessibility-http-")), runtime = accessibilityRuntime(profile, installed!, hold);
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const privateInput = new URL(request.url).pathname === "/private" ? '<script>document.querySelector("#entry").addEventListener("input",()=>{document.querySelector("#audit button").id=document.querySelector("#entry").value})</script>' : "";
    return new Response(ACCESSIBILITY_FIXTURE_HTML + privateInput, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } });
  const origin = `http://127.0.0.1:${target.port}`;
  const daemon = await browserDaemon(profile, { RUNPHANTOM_BROWSER_MODULE: runtime.module });
  const birth = spawnSync("ps", ["-p", String(daemon.proc.pid), "-o", "lstart=,command="], { encoding: "utf8" }).stdout.trim();
  const responses: Array<{ route: string; status: number; body: unknown }> = [], originalApi = daemon.api;
  daemon.api = async (...args) => { const result = await originalApi(...args); if (args[0].startsWith("/browser") || args[0] === "/reports") responses.push({ route: args[0], status: result.status, body: result.body }); return result; };
  try { await callback(daemon, origin, runtime); }
  finally {
    writeFileSync(runtime.release, "release"); await daemon.stop(); expect(isReaped(daemon.proc)).toBe(true);
    const births = existsSync(runtime.pidFile) ? readFileSync(runtime.pidFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    for (const row of births) { expect(() => process.kill(row.pid, 0)).toThrow(); row.reaped = true; }
    const evidence = process.env.RUNPHANTOM_F35_TEST_EVIDENCE_DIR;
    if (evidence) {
      const output = mkdtempSync(path.join(evidence, "native-http-"));
      writeFileSync(path.join(output, "proof.json"), JSON.stringify({ claim: "actual current source daemon, genuine installed native engine; no paid/provider/copy acceptance", daemon: { pid: daemon.proc.pid, actualBirthAndCommand: birth, listener: daemon.url, reaped: isReaped(daemon.proc) }, targetOrigin: origin, holdAfterGenuineResult: hold, nativeBrowsers: births, responses }, null, 2));
      writeFileSync(path.join(output, "runtime-wrapper.mjs"), readFileSync(runtime.module));
    }
    await target.stop(true); rmSync(profile, { recursive: true, force: true });
  }
}
async function waitForHeld(file: string) { const deadline = Date.now() + 4000; while (!existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); expect(existsSync(file)).toBe(true); }

describe.skipIf(!installed)("registered real native accessibility API", () => {
  test("native findings, fixed controls, empty and opaque scopes retain exact provenance without changing business reports", async () => withDaemon(async (daemon, origin) => {
    const opened = await daemon.api("/browser/sessions", { engine: "chromium", url: origin }); expect(opened.status).toBe(201);
    const session = opened.body, route = `/browser/sessions/${session.id}`;
    const response = await daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: ["#audit"] });
    expect(response.status).toBe(200); const bad = response.body;
    expect(bad.source).toBe("host-run-native-engine"); expect(bad.sessionId).toBe(session.id); expect(bad.generation).toBe(session.generation);
    expect(bad.status).toBe("findings"); expect(bad.coverage).toBe("complete"); expect(bad.findings.map((item: any) => item.rule)).toEqual(expect.arrayContaining(["button-name", "image-alt", "label"]));
    const fixed = await daemon.api(`${route}/action`, { generation: session.generation, action: { type: "click", target: { kind: "css", selector: "#fix" } } }); expect(fixed.body.action.dispatch).toBe("completed");
    const good = await daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: ["#audit"] }); expect(good.status).toBe(200); expect(good.body.status).toBe("no-findings"); expect(good.body.coverage).toBe("complete");
    const empty = await daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: ["#empty"] }); expect(empty.body.status).toBe("inconclusive"); expect(empty.body.loss).toContain("no-applicable-nodes");
    for (const [region, loss] of [["#opaque", "closed-shadow-root"], ["#frameaudit", "iframe-excluded"]]) {
      const gap = await daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: [region] }); expect(gap.body.status).toBe("inconclusive"); expect(gap.body.coverage).toBe("partial"); expect(gap.body.loss).toContain(loss);
    }
    expect((await daemon.api("/reports")).body).toEqual([]); expect((await daemon.api("/sessions", { origin })).status).toBe(201);
    expect(JSON.stringify([bad, good.body, empty.body])).not.toContain("<input"); expect(JSON.stringify(bad)).not.toContain("srcdoc");
    expect((await daemon.api(`${route}/close`, { generation: session.generation })).body.session.state).toBe("closed");
  }), 40000);
  test("finite input, current generation, origin and JSON byte guards remain closed", async () => withDaemon(async (daemon, origin) => {
    const session = (await daemon.api("/browser/sessions", { engine: "chromium", url: origin })).body, route = `/browser/sessions/${session.id}/audit`;
    const request = { generation: session.generation, rules, regions: ["#audit"] };
    for (const body of [{ ...request, regions: [origin] }, { ...request, rules: ["unrecognized"] }, { ...request, html: "<button>" }, { ...request, regions: ["#audit", "#audit"] }]) expect((await daemon.api(route, body)).status).toBe(400);
    expect((await daemon.api(route, { ...request, generation: session.generation + 1 })).status).toBe(409);
    expect((await daemon.api(route, request, "POST", { Origin: "http://foreign.invalid" })).status).toBe(403);
    expect((await daemon.api(route, { padding: "x".repeat(BROWSER_LIMITS.FRAME_BYTES + 1) })).status).toBe(413);
    expect((await daemon.api(route, request)).body.status).toBe("findings");
  }), 25000);
  test("real held engine work blocks overlap and cancellation reaps authority before a late result", async () => withDaemon(async (daemon, origin, runtime) => {
    const session = (await daemon.api("/browser/sessions", { engine: "chromium", url: origin })).body, route = `/browser/sessions/${session.id}`;
    const pending = daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: ["#audit"] }); await waitForHeld(runtime.held);
    expect((await daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: ["#audit"] })).status).toBe(409);
    expect((await daemon.api(`${route}/action`, { generation: session.generation, action: { type: "click", target: { kind: "css", selector: "#fix" } } })).status).toBe(409);
    const cancelled = await daemon.api(`${route}/cancel`, { generation: session.generation }); expect(cancelled.body.session.state).toBe("closed");
    for (const row of readFileSync(runtime.pidFile, "utf8").trim().split("\n").map(line => JSON.parse(line))) expect(() => process.kill(row.pid, 0)).toThrow();
    writeFileSync(runtime.release, "release"); const late = await pending; expect([409, 503]).toContain(late.status); expect(late.body).not.toHaveProperty("findings");
    expect((await daemon.api("/reports")).body).toEqual([]);
  }, true), 30000);
  test("actual non-Chromium owned connection is explicitly inconclusive", async () => withDaemon(async (daemon, origin) => {
    const opened = await daemon.api("/browser/sessions", { engine: "firefox", url: origin }); expect(opened.status).toBe(201); const session = opened.body;
    const result = await daemon.api(`/browser/sessions/${session.id}/audit`, { generation: session.generation, rules, regions: ["#audit"] });
    expect(result.status).toBe(200); expect(result.body.status).toBe("inconclusive"); expect(result.body.coverage).toBe("unavailable"); expect(result.body.loss).toContain("unsupported-browser");
    expect(result.body.population.total).toBeNull(); expect(result.body.findings).toEqual([]);
  }), 25000);
  test("registered execution deadline closes and reaps the actual owned runtime without accepting an empty result", async () => withDaemon(async (daemon, origin, runtime) => {
    const session = (await daemon.api("/browser/sessions", { engine: "chromium", url: origin })).body, route = `/browser/sessions/${session.id}`;
    const started = Date.now(), pending = daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: ["#audit"] });
    await waitForHeld(runtime.held); const result = await pending;
    expect([409, 503]).toContain(result.status); expect(result.body).not.toHaveProperty("findings"); expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    const current = (await daemon.api("/browser/sessions")).body.find((item: any) => item.id === session.id); expect(current.state).toBe("closed");
    for (const row of readFileSync(runtime.pidFile, "utf8").trim().split("\n").map(line => JSON.parse(line))) expect(() => process.kill(row.pid, 0)).toThrow();
    expect((await daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: ["#audit"] })).status).toBe(409);
  }, true), 30000);
  test("actual entered private text cannot become retained engine selector authority or a clean result", async () => withDaemon(async (daemon, origin) => {
    const session = (await daemon.api("/browser/sessions", { engine: "chromium", url: `${origin}/private` })).body, route = `/browser/sessions/${session.id}`;
    const secret = "private-audit-input-7d309f";
    const filled = await daemon.api(`${route}/action`, { generation: session.generation, action: { type: "fill", target: { kind: "css", selector: "#entry" }, value: secret } }); expect(filled.body.action.dispatch).toBe("completed");
    const audit = await daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: ["#audit"] });
    expect(audit.status).toBe(200); expect(audit.body.status).toBe("findings"); expect(audit.body.coverage).toBe("partial"); expect(audit.body.loss).toContain("target-redacted");
    expect(JSON.stringify(audit.body)).not.toContain(secret); expect(JSON.stringify(audit.body)).not.toContain("<input"); expect(audit.body.population.total).toBe(3);
    expect((await daemon.api(`${route}/audit`, { generation: session.generation, rules, regions: [`#${secret}`] })).status).toBe(400);
    expect((await daemon.api("/reports")).body).toEqual([]);
  }), 25000);
});
