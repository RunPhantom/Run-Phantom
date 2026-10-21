import { describe, expect, test } from "bun:test";
import { parseRecordingBatch, RECORDING_LIMITS, type RecordingBatch } from "../src/verification/recording-types";
import { parseProducerPull } from "../src/verification/browser/recorder";

function batch(): RecordingBatch {
  return { version: 1, document: 1, sequence: 0, dropped: 0, loss: false, events: [
    { ordinal: 1, epochMs: 1000, kind: 0, viewport: [800, 600], visited: 3, clipped: false, nodes: [{ id: 1, kind: 0, rect: [10, 20, 100, 30], paint: [0, 33, 204, 255] }] },
    { ordinal: 2, epochMs: 1001, kind: 2, target: 1, x: 15, y: 22 },
  ] };
}

describe("masked recording boundary (AC-2, AC-4, AC-6)", () => {
  test("retains only the complete closed numeric layout/event shape", () => {
    const source = JSON.stringify(batch());
    expect(parseRecordingBatch(source)).toEqual(batch());
    expect(parseRecordingBatch(new TextEncoder().encode(source))).toEqual(batch());
  });
  test("refuses raw text, input values, URLs and HTML even on unknown nested fields", () => {
    for (const field of ["text", "value", "url", "html", "style", "onload", "__proto__"]) {
      const value = batch();
      Object.defineProperty(value.events[0], field, { value: "SYNTHETIC_PRIVATE_TOKEN", enumerable: true });
      expect(() => parseRecordingBatch(JSON.stringify(value))).toThrow();
    }
  });
  test("rejects duplicate fields, lossy integer encodings and noncanonical raw strings", () => {
    const source = JSON.stringify(batch());
    for (const raw of [source.replace('"version":1', '"version":1,"version":1'), source.replace('"document":1', '"document":9007199254740993'), ` ${source}`, source.replace('"sequence":0', '"sequence":-0')]) {
      expect(() => parseRecordingBatch(raw)).toThrow();
    }
  });
  test("checks bytes, UTF-8 and population before retaining a payload", () => {
    expect(() => parseRecordingBatch("x".repeat(RECORDING_LIMITS.batchBytes + 1))).toThrow();
    expect(() => parseRecordingBatch(new Uint8Array([0xc0, 0xaf]))).toThrow();
    const value = batch();
    value.events = Array.from({ length: RECORDING_LIMITS.eventsPerBatch + 1 }, (_, i) => ({ ordinal: i + 1, epochMs: 1000 + i, kind: 2 as const, target: null, x: null, y: null }));
    expect(() => parseRecordingBatch(JSON.stringify(value))).toThrow();
  });
  test("checks geometry, viewport, paint, node uniqueness and event order", () => {
    const modifications = [
      (v: RecordingBatch) => { const frame = v.events[0]; if (frame.kind === 0) frame.nodes[0].rect[2] = -1; },
      (v: RecordingBatch) => { const frame = v.events[0]; if (frame.kind === 0) frame.viewport[0] = 1921; },
      (v: RecordingBatch) => { const frame = v.events[0]; if (frame.kind === 0) frame.nodes[0].paint[3] = 256; },
      (v: RecordingBatch) => { const frame = v.events[0]; if (frame.kind === 0) frame.nodes.push(frame.nodes[0]); },
      (v: RecordingBatch) => { v.events[1].ordinal = v.events[0].ordinal; },
      (v: RecordingBatch) => { v.events[1].epochMs = v.events[0].epochMs - 1; },
      (v: RecordingBatch) => { const frame = v.events[0]; if (frame.kind === 0) frame.visited = 2001; },
    ];
    for (const change of modifications) { const value = batch(); change(value); expect(() => parseRecordingBatch(JSON.stringify(value))).toThrow(); }
    expect(() => parseRecordingBatch(JSON.stringify(batch()).replace('[10,20,100,30]', '[1e400,20,100,30]'))).toThrow();
  });
  test("keeps observed loss explicit and admits a valid control after refusals", () => {
    const value = batch(); value.loss = true; value.dropped = null;
    expect(parseRecordingBatch(JSON.stringify(value)).dropped).toBeNull();
    expect(parseRecordingBatch(JSON.stringify(batch())).loss).toBe(false);
  });
  test("checks the complete producer envelope and native clock before storage", () => {
    const envelope = { batch: JSON.stringify(batch()), loss: false, dropped: 0, stopped: false, reason: "none" as const, clock: { anchorEpochMs: 1000, nowEpochMs: 1001, monotonicElapsedMs: 1.1 } };
    expect(parseProducerPull(JSON.stringify(envelope))).toEqual(envelope);
    for (const value of [{ ...envelope, html: "private" }, { ...envelope, reason: "private" }, { ...envelope, loss: true }, { ...envelope, clock: { ...envelope.clock, nowEpochMs: null } }, { ...envelope, clock: { ...envelope.clock, url: "private" } }, { ...envelope, clock: { ...envelope.clock, monotonicElapsedMs: -1 } }]) expect(() => parseProducerPull(JSON.stringify(value))).toThrow();
  });
  test("keyboard/input and document boundaries cannot carry invented pointer observations", () => {
    for (const kind of [3, 4, 5, 6, 7, 8] as const) {
      const value = batch(); const observation = value.events[1]; if (observation.kind !== 0) observation.kind = kind;
      expect(() => parseRecordingBatch(JSON.stringify(value))).toThrow();
    }
    const value = batch(), observation = value.events[1];
    if (observation.kind !== 0) { observation.kind = 8; observation.x = null; observation.y = null; }
    expect(() => parseRecordingBatch(JSON.stringify(value))).toThrow();
  });
});
