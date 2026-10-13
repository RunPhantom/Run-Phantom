import { describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { recordingStoreFixture } from "./helpers/recording-store-fixture";
import { type RecordingAdmission } from "../src/verification/recording";
import { RECORDING_LIMITS as L, type RecordingBatch } from "../src/verification/recording-types";

function admission(runId = "fixture-run-1"): RecordingAdmission {
  return { runId, sessionId: randomBytes(16).toString("hex"), engine: "chromium", engineVersion: "native-fixture-version", startedAt: 1000, clockOffsetMs: 0, clockUncertaintyMs: 1 };
}
function batch(sequence = 0, ordinalBase = 0, epoch = 1000): RecordingBatch {
  return { version: 1, document: 1, sequence, dropped: 0, loss: false, events: [{ ordinal: ordinalBase + 1, epochMs: epoch, kind: sequence === 0 ? 8 : 7, target: null, x: null, y: null }] };
}
describe("guarded native recording persistence (AC-4, AC-5, AC-8)", () => {
  test("physical clock, live token and loss identity cannot be changed", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(), lease = store.admit(admission());
      for (const assignment of ["clock_offset_ms=3", "clock_uncertainty_ms=3", `job_token='${"f".repeat(64)}'`]) expect(() => fixture.db.query(`UPDATE browser_recordings SET ${assignment} WHERE recording_id=?`).run(lease.summary.id)).toThrow();
      expect(store.finish(lease.summary.id, lease.token, "partial", "queue", 1001)).toBe(true);
      expect(() => fixture.db.query("UPDATE browser_recordings SET loss=0 WHERE recording_id=?").run(lease.summary.id)).toThrow();
      store.delete(lease.summary.id); expect(store.get(lease.summary.id).status).toBe("deleted");
    } finally { fixture.close(); }
  });
  test("retains ordered immutable bytes and exact duplicate acknowledgment", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(), lease = store.admit(admission()), raw = JSON.stringify(batch());
      expect(store.publish(lease.summary.id, lease.token, raw)).toEqual({ accepted: true, duplicate: false });
      expect(store.publish(lease.summary.id, lease.token, raw)).toEqual({ accepted: true, duplicate: true });
      expect(() => store.publish(lease.summary.id, lease.token, JSON.stringify({ ...batch(), dropped: 1, loss: true }))).toThrow("Changed recording retry");
      expect(() => store.publish(lease.summary.id, lease.token, JSON.stringify(batch(2, 1)))).toThrow("sequence gap");
      expect(store.batches(lease.summary.id).entries).toHaveLength(1);
      expect(store.get(lease.summary.id).bytes).toBe(Buffer.byteLength(raw));
      expect(() => fixture.db.query("UPDATE browser_recording_batches SET digest=? WHERE recording_id=?").run("0".repeat(64), lease.summary.id)).toThrow();
      const before = store.batches(lease.summary.id);
      fixture.restart(); const current = fixture.store(); expect(current.recover()).toBe(1);
      expect(current.batches(lease.summary.id).entries).toEqual(before.entries);
      expect(current.get(lease.summary.id).status).toBe("interrupted");
      expect(current.recover()).toBe(0);
      expect(() => store.publish(lease.summary.id, lease.token, JSON.stringify(batch(1, 1)))).toThrow("authority is no longer current");
    } finally { fixture.close(); }
  });
  test("authorizes scope before lookup and fences cancel/delete publication", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(), lease = store.admit(admission());
      fixture.revoke(); expect(() => store.get(lease.summary.id)).toThrow("authority revoked"); expect(() => store.get("invalid-id")).toThrow("authority revoked"); fixture.restore();
      fixture.db.query("INSERT INTO browser_recording_scopes VALUES(?,1)").run("other:fixture");
      expect(() => fixture.store("other:fixture").get(lease.summary.id)).toThrow("not found");
      expect(store.finish(lease.summary.id, lease.token, "cancelled", "cancelled", 1001)).toBe(true);
      expect(store.publish(lease.summary.id, lease.token, JSON.stringify(batch()))).toEqual({ accepted: false, reason: "stale" });
      store.delete(lease.summary.id); expect(store.publish(lease.summary.id, lease.token, JSON.stringify(batch()))).toEqual({ accepted: false, reason: "stale" });
      expect(() => store.batches(lease.summary.id)).toThrow("deleted");
      expect(store.list("fixture-run-1")).toEqual([]);
      expect(() => fixture.db.query("DELETE FROM browser_recordings").run()).toThrow("lifetime identity retained");
    } finally { fixture.close(); }
  });
  test("unknown initial clock stays explicit and corruption still permits privacy deletion", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(), lease = store.admit({ ...admission(), clockOffsetMs: null, clockUncertaintyMs: null });
      expect(lease.summary).toMatchObject({ loss: true, reason: "clock", clockOffsetMs: null, clockUncertaintyMs: null });
      store.publish(lease.summary.id, lease.token, JSON.stringify(batch()));
      expect(store.finish(lease.summary.id, lease.token, "complete", "none", 1001)).toBe(true); expect(store.get(lease.summary.id).status).toBe("partial");
      fixture.db.exec("DROP TRIGGER browser_recording_batch_immutable"); fixture.db.query("UPDATE browser_recording_batches SET digest=? WHERE recording_id=?").run("0".repeat(64), lease.summary.id);
      expect(() => store.batches(lease.summary.id)).toThrow("integrity"); store.delete(lease.summary.id);
      expect((fixture.db.query("SELECT count(*) n FROM browser_recording_batches").get() as { n: number }).n).toBe(0);
    } finally { fixture.close(); }
  });
  test("corrupt counters refuse payload materialization and allow privacy deletion", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(), lease = store.admit(admission());
      store.publish(lease.summary.id, lease.token, JSON.stringify(batch()));
      fixture.db.query("UPDATE browser_recordings SET retained_bytes=1 WHERE recording_id=?").run(lease.summary.id);
      const nativeQuery = fixture.db.query.bind(fixture.db); let payloadReads = 0;
      const monitor = spyOn(fixture.db, "query").mockImplementation(sql => { if (sql.startsWith("SELECT sequence,CASE WHEN")) payloadReads++; return nativeQuery(sql); });
      try { expect(() => store.batches(lease.summary.id)).toThrow("accounting"); expect(payloadReads).toBe(0); }
      finally { monitor.mockRestore(); }
      store.delete(lease.summary.id); expect(store.get(lease.summary.id)).toMatchObject({ status: "deleted", bytes: 0, batches: 0 });
    } finally { fixture.close(); }
  });
  test("loss with no producer cause remains unavailable rather than inventing queue pressure", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(), lease = store.admit(admission());
      store.publish(lease.summary.id, lease.token, JSON.stringify({ ...batch(), loss: true, dropped: null }));
      expect(store.get(lease.summary.id)).toMatchObject({ loss: true, reason: "unavailable", dropped: null });
    } finally { fixture.close(); }
  });
  test("empty observations and document transitions remain truthful", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(), empty = store.admit(admission());
      expect(store.finish(empty.summary.id, empty.token, "complete", "none", 1001)).toBe(true);
      expect(store.get(empty.summary.id)).toMatchObject({ status: "partial", loss: true, reason: "unavailable", events: 0 });
      const lease = store.admit(admission("fixture-run-document")); store.publish(lease.summary.id, lease.token, JSON.stringify(batch()));
      const changed = batch(1, 1, 1002); changed.document = 2;
      expect(() => store.publish(lease.summary.id, lease.token, JSON.stringify(changed))).toThrow("continuity");
      changed.events[0].kind = 8; expect(store.publish(lease.summary.id, lease.token, JSON.stringify(changed)).accepted).toBe(true);
      expect(store.get(lease.summary.id)).toMatchObject({ loss: true, reason: "document", events: 2 });
    } finally { fixture.close(); }
  });
  test("real per-record/global bytes refuse growth and leave stop/delete usable", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(); let aggregateRefusal = false;
      const retained: string[] = [];
      for (let recording = 0; recording < 12; recording++) {
        const lease = store.admit(admission(`fixture-run-cap-${recording}`)); retained.push(lease.summary.id);
        let accepted = 0;
        for (let sequence = 0; sequence < 120; sequence++) {
          const epoch = 1000 + sequence * 500, ordinal = sequence * 64;
          const value = batch(sequence, ordinal, epoch);
          const nodes = Array.from({ length: 256 }, (_, index) => ({ id: index + 1, kind: 0 as const, rect: [Number("10.123456789012345"), Number("20.123456789012345"), Number("100.12345678901234"), Number("30.123456789012345")] as [number, number, number, number], paint: [0, 33, 204, 255] as [number, number, number, number] }));
          value.events.push({ ordinal: ordinal + 2, epochMs: epoch, kind: 0, viewport: [800, 600], visited: 256, clipped: false, nodes });
          for (let slot = 2; slot < 64; slot++) value.events.push({ ordinal: ordinal + slot + 1, epochMs: epoch, kind: 7, target: 1, x: null, y: null });
          const raw = JSON.stringify(value), before = store.get(lease.summary.id);
          const result = store.publish(lease.summary.id, lease.token, raw);
          const total = (fixture.db.query("SELECT coalesce(sum(length(cast(data AS BLOB))),0) bytes FROM browser_recording_batches").get() as { bytes: number }).bytes;
          expect(total).toBeLessThanOrEqual(L.aggregateBytes); expect(store.get(lease.summary.id).bytes).toBeLessThanOrEqual(L.recordingBytes);
          if (!result.accepted) {
            expect(result.reason).toBe("capacity"); expect(store.get(lease.summary.id)).toMatchObject({ status: "partial", reason: "capacity", bytes: before.bytes, batches: before.batches });
            aggregateRefusal = total + Buffer.byteLength(raw) > L.aggregateBytes; break;
          }
          accepted++;
        }
        if (!aggregateRefusal) expect(accepted).toBeGreaterThan(0);
        const head = store.get(lease.summary.id);
        if (head.status === "recording") expect(store.finish(head.id, lease.token, "complete", "none", 61_000)).toBe(true);
        if (aggregateRefusal) break;
      }
      expect(aggregateRefusal).toBe(true);
      for (const id of retained) store.delete(id);
      expect((fixture.db.query("SELECT count(*) n FROM browser_recording_batches").get() as { n: number }).n).toBe(0);
      const control = store.admit(admission("fixture-run-control")); expect(store.publish(control.summary.id, control.token, JSON.stringify(batch())).accepted).toBe(true);
    } finally { fixture.close(); }
  }, 25_000);
  test("active, per-browser, per-run, retained and lifetime populations stay bounded", () => {
    const fixture = recordingStoreFixture();
    try {
      const store = fixture.store(), first = store.admit(admission());
      expect(() => store.admit({ ...admission(), sessionId: first.summary.sessionId })).toThrow("capacity");
      const second = store.admit(admission()); expect(() => store.admit(admission())).toThrow("capacity");
      store.finish(first.summary.id, first.token, "cancelled", "cancelled", 1001); store.finish(second.summary.id, second.token, "cancelled", "cancelled", 1001);
      for (let slot = 2; slot < 16; slot++) { const lease = store.admit(admission()); store.finish(lease.summary.id, lease.token, "cancelled", "cancelled", 1001); }
      expect(store.list("fixture-run-1")).toHaveLength(16); expect(() => store.admit(admission())).toThrow("capacity");
      store.delete(first.summary.id); const replacement = store.admit(admission()); store.finish(replacement.summary.id, replacement.token, "cancelled", "cancelled", 1001);
      for (let slot = 0; slot < 84; slot++) { const lease = store.admit(admission(`fixture-run-global-${slot}`)); store.finish(lease.summary.id, lease.token, "cancelled", "cancelled", 1001); }
      expect(() => store.admit(admission("fixture-run-global-refused"))).toThrow("capacity");
      const retained = fixture.db.query("SELECT recording_id id FROM browser_recordings WHERE status<>'deleted'").all() as { id: string }[]; expect(retained).toHaveLength(100);
      for (const row of retained) store.delete(row.id);
      const lifetimes = (fixture.db.query("SELECT count(*) n FROM browser_recordings").get() as { n: number }).n;
      for (let slot = lifetimes; slot < 1000; slot++) { const lease = store.admit(admission("fixture-run-lifetime")); store.finish(lease.summary.id, lease.token, "cancelled", "cancelled", 1001); store.delete(lease.summary.id); }
      expect((fixture.db.query("SELECT count(*) n FROM browser_recordings").get() as { n: number }).n).toBe(1000);
      expect(() => store.admit(admission("fixture-run-lifetime-refused"))).toThrow("capacity");
      expect((fixture.db.query("SELECT count(*) n FROM browser_recording_batches").get() as { n: number }).n).toBe(0);
    } finally { fixture.close(); }
  }, 20_000);
});
