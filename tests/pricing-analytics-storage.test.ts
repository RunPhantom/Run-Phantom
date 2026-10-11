import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { getLocalCostAnalytics } from "../src/pricing/local";
import { ANALYTICS_LIMITS } from "../src/pricing/analytics";
import { TeamStore, hashTeamToken } from "../src/team/store";
import { normalizeTeamIngest } from "../src/team/ingest";
import { rateFixture } from "./fixtures/pricing";

const cleanup: Array<() => void> = [];
const input = { from: 0, to: 86_400_000, bucket: "hour", estimateMode: "captured", rates: [rateFixture()] };
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function team() {
  const directory = mkdtempSync(join(tmpdir(), "rp-pricing-team-"));
  let now = 1_800_000_000_000;
  const store = new TeamStore(join(directory, "team.sqlite"), { bootstrapHash: hashTeamToken("bootstrap"), now: () => now });
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.setupOwner({ setupCodeHash: hashTeamToken("bootstrap"), email: "owner@example.test", passwordHash: "fixture-password", sessionHash: hashTeamToken("owner-session") });
  const a = store.createProject(owner, { name: "Pricing A" }), b = store.createProject(owner, { name: "Pricing B" });
  const scope = store.projectScope(owner, a.id), other = store.projectScope(owner, b.id);
  const request = { ...input, from: now - 86_400_000, to: now + 1 };
  function ingest(project = scope, tokens = 200, cost = .123) {
    const key = store.createKey(project, { label: "Synthetic pricing capture" });
    const attributes = { "runphantom.span.kind": "llm_call", "gen_ai.response.model": "fixture-model", "gen_ai.provider.name": "fixture-provider", "runphantom.usage.tier": "standard", "gen_ai.usage.input_tokens": tokens, "gen_ai.usage.output_tokens": 300, "gen_ai.usage.cost_usd": cost };
    const body = { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "1".repeat(32), spanId: "2".repeat(16), name: "Synthetic pricing capture", startTimeUnixNano: String(BigInt(now - 1_000) * 1_000_000n), endTimeUnixNano: String(BigInt(now - 900) * 1_000_000n), attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: typeof value === "number" ? { doubleValue: value } : { stringValue: value } })) }] }] }] };
    store.ingest(store.getIngestContext(hashTeamToken(key.token))!, normalizeTeamIngest(Buffer.from(JSON.stringify(body)), "json", key.token));
  }
  return { directory, store, owner, scope, other, request, ingest, advance: (ms: number) => { now += ms; } };
}
function local() {
  const directory = mkdtempSync(join(tmpdir(), "rp-pricing-local-"));
  const previous = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = join(directory, "local.sqlite");
  const db = getDrizzleDb().$client;
  cleanup.push(() => { closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; rmSync(directory, { recursive: true, force: true }); });
  db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('run','Synthetic',1,10)").run();
  const attrs = JSON.stringify({ "runphantom.usage.tier": "standard", "gen_ai.usage.cost_usd": .123 });
  db.query("INSERT INTO spans(run_id,id,name,span_type,start_time_ms,model,provider,input_tokens,output_tokens,attributes) VALUES('run','generation','Synthetic','LLM_GENERATION',1000,'fixture-model','fixture-provider',200,300,?)").run(attrs);
  return db;
}

describe("actual private TeamStore cost analytics", () => {
  test("same run/span identity stays within the current project and binds exact source", () => {
    const f = team(); f.ingest(); f.ingest(f.other, 9_000, 9);
    const result = f.store.pricingAnalytics(f.scope, f.request);
    expect(result.scope).toEqual({ kind: "team", projectId: f.scope.projectId });
    expect(result.tokens.input.completeTotal).toBe(200);
    expect(result.reportedUsd.completeTotal).toBe(.123);
    expect(result.estimatedUsd.completeTotal).toBeCloseTo(.0051, 12);
    expect(result.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(f.store.pricingAnalytics(f.scope, f.request).sourceRevision).toBe(result.sourceRevision);
    f.ingest(f.scope, 201);
    expect(f.store.pricingAnalytics(f.scope, f.request).sourceRevision).not.toBe(result.sourceRevision);
    expect(JSON.stringify(result)).not.toContain("fixture-password");
  });
  test("captured rate revision changes bind the source revision without rewriting reported costs", () => {
    const f = team(); f.ingest();
    const before = f.store.pricingAnalytics(f.scope, f.request);
    const after = f.store.pricingAnalytics(f.scope, { ...f.request, rates: [rateFixture({}, { revision: "next-frozen-rate" })] });
    expect(after.sourceRevision).not.toBe(before.sourceRevision);
    expect(after.reportedUsd).toEqual(before.reportedUsd);
  });
  test("revoked session cannot reuse a previously accepted context", () => {
    const f = team(); f.ingest(); f.store.logout(f.owner);
    expect(() => f.store.pricingAnalytics(f.scope, f.request)).toThrow("Authentication required");
  });
  test("expired session and removed membership refuse current data", () => {
    const f = team(); f.ingest();
    const invite = f.store.createInvite(f.scope, { email: "viewer@example.test", role: "viewer" });
    const viewer = f.store.acceptInvite({ tokenHash: hashTeamToken(invite.token), email: "viewer@example.test", expectedAccountId: null, passwordHash: "viewer-password", sessionHash: hashTeamToken("viewer-session") }).context;
    const stale = f.store.projectScope(viewer, f.scope.projectId);
    expect(f.store.pricingAnalytics(stale, f.request).tokens.input.completeTotal).toBe(200);
    expect(() => f.store.pricingAnalytics({ ...stale, projectId: f.other.projectId, role: "admin" }, f.request)).toThrow("Resource not found");
    f.store.removeMember(f.scope, viewer.user.id);
    expect(() => f.store.pricingAnalytics(stale, f.request)).toThrow("Resource not found");
    f.advance(31 * 60_000);
    expect(() => f.store.pricingAnalytics(f.scope, f.request)).toThrow("Authentication required");
  });
  test("deleted project refuses stale authority and never returns a zero population", () => {
    const f = team(); f.ingest();
    const db = new Database(join(f.directory, "team.sqlite"));
    db.exec("PRAGMA foreign_keys=ON"); db.query("DELETE FROM projects WHERE id=?").run(f.scope.projectId); db.close();
    expect(() => f.store.pricingAnalytics(f.scope, f.request)).toThrow("Resource not found");
  });
});

describe("actual local SQLite analytics acquisition", () => {
  test("reads persisted rows without modifying their reported snapshot evidence", () => {
    const db = local(); const before = db.query("SELECT * FROM spans").all();
    const result = getLocalCostAnalytics(input);
    expect(result.reportedUsd.completeTotal).toBe(.123);
    expect(result.estimatedUsd.completeTotal).toBeCloseTo(.0051, 12);
    expect(db.query("SELECT * FROM spans").all()).toEqual(before);
  });
  test("full ancestor context outside the window changes the roster and prevents double counting", () => {
    const db = local();
    const before = getLocalCostAnalytics(input);
    db.query("INSERT INTO spans(run_id,id,name,span_type,start_time_ms,input_tokens,output_tokens) VALUES('run','parent','Parent','LLM_GENERATION',1,500,500)").run();
    db.query("UPDATE spans SET parent_span_id='parent' WHERE id='generation'").run();
    const after = getLocalCostAnalytics({ ...input, from: 500 });
    expect(after.sourceRevision).not.toBe(before.sourceRevision);
    expect(after.population).toMatchObject({ acquiredSpans: 2, nestedExcluded: 1, outsideWindow: 1 });
    expect(after.estimatedUsd.eligibleCount).toBe(0);
  });
  test("project-size admission happens before acquiring an oversized population", () => {
    const db = local();
    db.transaction(() => { for (let i = 0; i < ANALYTICS_LIMITS.spans; i++) db.query("INSERT INTO spans(run_id,id,name,span_type,start_time_ms) VALUES('run',?,'Context','INTERNAL',1)").run(`context-${i}`); })();
    expect(() => getLocalCostAnalytics(input)).toThrow("complete-population limit");
  });
  test("secret model identities remain unavailable and never enter groups", () => {
    const db = local(); const secret = "rp_team_session_" + "A".repeat(43);
    db.query("UPDATE spans SET model=?,attributes=?").run(secret, JSON.stringify({ "gen_ai.response.model": secret, "gen_ai.usage.cost_usd": .123, "secret.payload": "private prompt text" }));
    const result = getLocalCostAnalytics(input);
    expect(result.byModel[0].identity).toBeNull();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("private prompt text");
  });
});
