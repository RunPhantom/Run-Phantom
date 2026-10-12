import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDrizzleDb, searchRun } from "../src/db";

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
});
