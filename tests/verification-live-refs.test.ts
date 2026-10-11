import { describe, expect, test } from "bun:test";
import { LIVE_REF_TTL_MS, MAX_LIVE_REFS, LiveElementRefs } from "../src/verification/browser/dom/refs";

function documentScope() {
  const doc = { nodeType: 9 } as unknown as Document;
  const view = { document: doc, frameElement: null };
  Object.assign(doc, { defaultView: view });
  return { doc, view };
}
function element(doc: Document) {
  return { ownerDocument: doc, isConnected: true, getRootNode: () => doc } as unknown as Element;
}
function random() { let sequence = 0; return () => (++sequence).toString(16).padStart(32, "0"); }

describe("connection-owned live element references", () => {
  test("a token keeps the exact element and cannot be borrowed by another session registry", () => {
    const { doc } = documentScope(); const target = element(doc);
    const refs = new LiveElementRefs("session-a", doc, { random: random() });
    const ref = refs.refFor(target);
    expect(refs.refFor(target)).toBe(ref); expect(refs.resolve(ref)).toBe(target);
    const foreign = new LiveElementRefs("session-b", doc, { random: () => "f".repeat(32) });
    expect(() => foreign.resolve(ref)).toThrow("another session/document");
    expect(() => refs.resolve("button:nth-child(1)")).toThrow("Invalid live reference");
  });

  test("expiry is absolute rather than refreshed by reads or rediscovery", () => {
    const { doc } = documentScope(); let now = 10;
    const refs = new LiveElementRefs("session-a", doc, { now: () => now, random: random() });
    const target = element(doc); const old = refs.refFor(target);
    now += LIVE_REF_TTL_MS - 1; expect(refs.resolve(old)).toBe(target); expect(refs.refFor(target)).toBe(old);
    now++; expect(() => refs.resolve(old)).toThrow("expired");
    const fresh = refs.refFor(target); expect(fresh).not.toBe(old); expect(refs.resolve(fresh)).toBe(target);
  });

  test("detach, owner adoption, top document replacement and disconnect never rebind a token", () => {
    const { doc, view } = documentScope(); const target = element(doc);
    const refs = new LiveElementRefs("session-a", doc, { random: random() }); const ref = refs.refFor(target);
    Object.assign(target, { isConnected: false }); expect(() => refs.resolve(ref)).toThrow("stale");
    Object.assign(target, { isConnected: true }); expect(() => refs.resolve(ref)).toThrow("stale");
    const adopted = refs.refFor(target); Object.assign(target, { ownerDocument: documentScope().doc });
    expect(() => refs.resolve(adopted)).toThrow("stale");
    Object.assign(target, { ownerDocument: doc }); const next = refs.refFor(target);
    view.document = documentScope().doc; expect(() => refs.resolve(next)).toThrow("stale");
    view.document = doc; refs.invalidate(); expect(() => refs.refFor(target)).toThrow("outside");
  });

  test("old frame elements remain stale even if their detached Document still reports connected nodes", () => {
    const top = documentScope(); const frameDoc = documentScope(); const target = element(frameDoc.doc);
    const frame = Object.assign(element(top.doc), { contentDocument: frameDoc.doc });
    Object.assign(frameDoc.view, { frameElement: frame });
    const refs = new LiveElementRefs("session-a", top.doc, { random: random() }); const ref = refs.refFor(target);
    expect(refs.resolve(ref)).toBe(target);
    frame.contentDocument = documentScope().doc; expect(() => refs.resolve(ref)).toThrow("stale");
  });

  test("lifetime issuance remains bounded while expired reverse records are pruned without rebinding", () => {
    const { doc } = documentScope(); let now = 0;
    const refs = new LiveElementRefs("session-a", doc, { random: random(), now: () => now });
    const first = element(doc); const firstRef = refs.refFor(first);
    for (let index = 1; index < MAX_LIVE_REFS; index++) refs.refFor(element(doc));
    expect(refs.size).toBe(MAX_LIVE_REFS); expect(refs.resolve(firstRef)).toBe(first);
    expect(() => refs.refFor(element(doc))).toThrow("capacity");
    now = LIVE_REF_TTL_MS; expect(refs.size).toBe(0);
    expect(() => refs.resolve(firstRef)).toThrow("stale"); expect(() => refs.refFor(first)).toThrow("capacity");
  });

  test("random collisions are regenerated and repeated collisions cannot overwrite another element", () => {
    const { doc } = documentScope(); let calls = 0;
    const refs = new LiveElementRefs("session-a", doc, { random: () => (++calls < 4 ? "a" : "b").repeat(32) });
    const first = element(doc); const second = element(doc); const ref = refs.refFor(first);
    expect(refs.refFor(second)).not.toBe(ref); expect(refs.resolve(ref)).toBe(first);
    expect(() => refs.refFor(element(doc))).toThrow("collision"); expect(refs.resolve(ref)).toBe(first);
  });

  test("a forced collision after expiry cannot reuse a previously handed-out token", () => {
    const { doc } = documentScope(); let now = 0;
    const refs = new LiveElementRefs("session-a", doc, { random: () => "a".repeat(32), now: () => now });
    const target = element(doc); const ref = refs.refFor(target);
    now = LIVE_REF_TTL_MS; expect(refs.size).toBe(0);
    expect(() => refs.refFor(target)).toThrow("collision"); expect(() => refs.resolve(ref)).toThrow("stale");
    const next = new LiveElementRefs("session-a", doc, { random: () => "b".repeat(32) });
    expect(() => next.resolve(ref)).toThrow("another session/document"); expect(next.resolve(next.refFor(target))).toBe(target);
  });
});
