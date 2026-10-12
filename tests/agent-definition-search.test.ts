import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDrizzleDb, searchRun } from "../src/db";
import { parseOtlpRequest } from "../src/parse";
import { definitionKey, definitionTrace } from "./fixtures/agent-definitions";

let directory: string, original: string | undefined;
const budget = 16 * 1024 * 1024;
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-definition-search-")); original = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "search.db"); getDrizzleDb();
});
beforeEach(() => { clearAll(); getDrizzleDb().$client.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('search','fixture',1,1)").run(); });
afterAll(() => {
  closeDb(); if (original === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = original;
  rmSync(directory, { recursive: true, force: true });
});
function insert() { getDrizzleDb().$client.query("INSERT INTO spans(run_id,id,name,input_payload,output_payload,attributes) VALUES('search','root','Business name','Business input','Business output','{}')").run(); }

describe("bounded same-population typed search companion", () => {
  test.each(["id", "name", "input_payload", "output_payload", "attributes"])("all acquired %s bytes are admitted before raw rows materialize", field => {
    insert(); const db = getDrizzleDb().$client;
    db.exec(`UPDATE spans SET ${field}=CAST(zeroblob(${budget + 1}) AS TEXT)`);
    let allocations = 0; const prepare = db.prepare.bind(db);
    const observed = spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      return new Proxy(statement, { get(target, key) {
        if (key === "all") return (...args: any[]) => { allocations++; return target.all(...args); };
        const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
      } });
    }) as typeof db.prepare);
    try {
      expect(() => searchRun("search", { pattern: "Business", scope: ["span_input", "span_output", "span_attributes"] })).toThrow("search evidence limits");
      expect(allocations).toBe(0);
    } finally { observed.mockRestore(); }
  });
  test("oversized unselected payload scopes are not acquired by attribute search", () => {
    insert(); getDrizzleDb().$client.exec(`UPDATE spans SET input_payload=CAST(zeroblob(${budget + 1}) AS TEXT), output_payload=CAST(zeroblob(${budget + 1}) AS TEXT)`);
    expect(searchRun("search", { pattern: "{}", scope: ["span_attributes"] }).matches).toHaveLength(1);
  });
  test("span row-count refusal is explicit rather than sampled empty results", () => {
    const db = getDrizzleDb().$client;
    db.transaction(() => { const query = db.query("INSERT INTO spans(run_id,id,name,input_payload,attributes) VALUES('search',?,'span','Business input','{}')"); for (let i = 0; i < 2001; i++) query.run(`span-${i}`); })();
    expect(() => searchRun("search", { pattern: "Business", scope: ["span_input"] })).toThrow("search evidence limits");
  });
  test.each(["valid", "missing", "oversized", "malformed", "loss", "duplicate"])("%s typed companion never becomes raw nested search evidence", kind => {
    const capture = definitionTrace(94), marker = "Private nested search definition";
    capture.body.resourceSpans[0].scopeSpans[0].spans[0].attributes.push({ key: "ordinary.envelope", value: { kvlistValue: { values: [
      { key: "ordinary.sibling", value: { stringValue: "Business metadata unchanged" } },
      { key: definitionKey, value: { stringValue: marker } },
    ] } } } as any);
    const parsed = parseOtlpRequest(capture.body)[0], typed = parsed.otlpEvidence;
    if (kind === "loss") typed.capture.droppedAttributes = 1;
    if (kind === "duplicate") typed.attributes.push(structuredClone(typed.attributes.at(-1)!));
    let receipt: string | null = JSON.stringify(typed);
    if (kind === "missing") receipt = null;
    if (kind === "malformed") receipt = receipt.slice(0, -1);
    if (kind === "oversized") receipt += " ".repeat(256 * 1024);
    getDrizzleDb().$client.query("INSERT INTO spans(run_id,id,name,attributes,otlp_evidence) VALUES('search','root','Business name',?,?)").run(JSON.stringify(parsed.attributes), receipt);
    expect(searchRun("search", { pattern: marker, scope: ["span_attributes"] }).matches).toEqual([]);
    const business = searchRun("search", { pattern: "span unchanged", scope: ["span_attributes"] });
    expect(business.matches).toHaveLength(1); expect(business.matches[0].snippet).toContain("span unchanged");
    expect(JSON.stringify(business)).not.toContain(marker);
    // The existing literal prefilter admits source matches, not a newly
    // generated projection marker. Inspect through the original carrier key.
    expect(searchRun("search", { pattern: "[UNAVAILABLE]", scope: ["span_attributes"] }).matches).toEqual([]);
    const carrier = searchRun("search", { pattern: "ordinary.envelope", scope: ["span_attributes"], context_chars: 400 });
    expect(carrier.matches).toHaveLength(1); expect(carrier.matches[0].snippet.includes("[UNAVAILABLE]")).toBe(kind !== "valid");
  });
  test("the entire admitted typed companion participates in the aggregate budget before materialization", () => {
    const capture = parseOtlpRequest(definitionTrace(95).body)[0];
    const serialized = JSON.stringify(capture.otlpEvidence), receipt = serialized + " ".repeat(256 * 1024 - Buffer.byteLength(serialized));
    const db = getDrizzleDb().$client;
    db.transaction(() => { const query = db.query("INSERT INTO spans(run_id,id,name,attributes,otlp_evidence) VALUES('search',?,'span','{}',?)"); for (let i = 0; i < 65; i++) query.run(`span-${i}`, receipt); })();
    expect(() => searchRun("search", { pattern: "{}", scope: ["span_attributes"] })).toThrow("search evidence limits");
  });
  test("UTF8 byte admission rejects a multibyte field below the UTF16 character budget", () => {
    insert(); getDrizzleDb().$client.query("UPDATE spans SET name=?").run("é".repeat(budget / 2));
    expect(() => searchRun("search", { pattern: "Business", scope: ["span_input"] })).toThrow("search evidence limits");
  });
});
