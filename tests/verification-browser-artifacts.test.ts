import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserArtifactStore } from "../src/verification/browser-artifacts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const source = { engine: "chromium" as const, ownership: "owned" as const, generation: 1 };
describe("private admitted browser artifact storage", () => {
  test("atomic artifact bytes and hash reopen without live authority or host paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rp-browser-artifact-"));
    try {
      const store = new BrowserArtifactStore(root);
      const meta = store.admit(png, { kind: "screenshot", raw: false, maskScope: "inputs-editable-private-known-secrets", ...source });
      expect(meta.width).toBe(1); expect(meta.height).toBe(1); expect(meta.bytes).toBe(png.length);
      expect(store.read(meta.id)).toEqual(png);
      const reopened = new BrowserArtifactStore(root); expect(reopened.list()).toEqual([meta]);
      expect(JSON.stringify(meta)).not.toContain(root); expect(JSON.stringify(meta)).not.toContain("sessionId");
      expect(() => reopened.read("../x")).toThrow();
      writeFileSync(path.join(root, `${meta.id}.png`), "corrupted");
      expect(() => reopened.read(meta.id)).toThrow("unavailable");
      expect(reopened.metadata(meta.id).availability).toBe("unavailable");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("symlink, unconsented raw, invalid dimensions and immutable capacity refuse", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rp-browser-artifact-cap-"));
    try {
      const store = new BrowserArtifactStore(root);
      expect(() => store.admit(png, { kind: "screenshot", raw: true, maskScope: "none", ...source })).toThrow();
      const huge = Buffer.from(png); huge.writeUInt32BE(1921, 16);
      expect(() => store.admit(huge, { kind: "screenshot", raw: false, maskScope: "inputs-editable-private-known-secrets", ...source })).toThrow();
      const first = store.admit(png, { kind: "screenshot", raw: false, maskScope: "inputs-editable-private-known-secrets", ...source });
      const file = path.join(root, `${first.id}.png`), external = path.join(root, "external.png"); writeFileSync(external, png); unlinkSync(file); symlinkSync(external, file);
      expect(() => store.read(first.id)).toThrow("unavailable");
      unlinkSync(file); writeFileSync(file, png, { mode: 0o600 });
      for (let i = 1; i < 100; i++) store.admit(png, { kind: "screenshot", raw: false, maskScope: "inputs-editable-private-known-secrets", ...source });
      const before = readFileSync(path.join(root, "manifest.json"));
      expect(() => store.admit(png, { kind: "screenshot", raw: false, maskScope: "inputs-editable-private-known-secrets", ...source })).toThrow("capacity");
      expect(readFileSync(path.join(root, "manifest.json"))).toEqual(before); expect(store.read(first.id)).toEqual(png);
      store.delete(first.id); expect(new BrowserArtifactStore(root).list()).toHaveLength(99);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
