import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CAPABILITY_LIMITS, CAPABILITY_VERSION, capabilityOwnerKey, ClaudeCapabilityRefusal, encodeClaudeCapability, readClaudeCapabilityDescriptor, type ClaudeCapabilityDescriptor } from "../src/coding-hooks/capability";

let directory: string, file: string, value: ClaudeCapabilityDescriptor;
const id = "a".repeat(32);
beforeEach(() => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-f11-capability-"))); chmodSync(directory, 0o700); file = path.join(directory, id + ".json");
  value = { version: CAPABILITY_VERSION, installationId: id, capabilityFile: file, ownerKey: capabilityOwnerKey(path.join(directory, "owner.sqlite")), state: "active", token: "b".repeat(64), ownerGeneration: "c".repeat(32), installationGeneration: "d".repeat(32), origin: "http://127.0.0.1:5947" };
  writeFileSync(file, encodeClaudeCapability(value), { mode: 0o600 });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
async function refusal(work: Promise<unknown>, reason?: ClaudeCapabilityRefusal["reason"]) { let result: unknown; try { await work; } catch (error) { result = error; } expect(result).toBeInstanceOf(ClaudeCapabilityRefusal); if (reason) expect((result as ClaudeCapabilityRefusal).reason).toBe(reason); }
test("reads the exact installed private descriptor without ambient profile/origin selection", async () => {
  expect(await readClaudeCapabilityDescriptor(file, id, value.ownerKey)).toEqual(value);
  const raw = readFileSync(file, "utf8"); writeFileSync(file, raw + " ".repeat(CAPABILITY_LIMITS.bytes - Buffer.byteLength(raw)));
  expect(await readClaudeCapabilityDescriptor(file, id, value.ownerKey)).toEqual(value);
});
test.each(["unknown", "null", "id", "owner", "path", "origin", "generation", "duplicate", "disabled_token"])("closed %s descriptor refuses without repair", async edit => {
  const changed: Record<string, unknown> = { ...value };
  if (edit === "unknown") changed.database = "/private/forged.sqlite";
  if (edit === "null") changed.token = null;
  if (edit === "id") changed.installationId = "e".repeat(32);
  if (edit === "owner") changed.ownerKey = "e".repeat(64);
  if (edit === "path") changed.capabilityFile = file + ".other";
  if (edit === "origin") changed.origin = "http://localhost:5947/redirect";
  if (edit === "generation") changed.ownerGeneration = "current";
  if (edit === "disabled_token") changed.state = "disabled";
  const raw = edit === "duplicate" ? JSON.stringify(value).replace('{', '{"token":"' + "b".repeat(64) + '",') : JSON.stringify(changed); writeFileSync(file, raw);
  await refusal(readClaudeCapabilityDescriptor(file, id, value.ownerKey), "corrupt"); expect(readFileSync(file, "utf8")).toBe(raw);
});
test("disabled descriptors contain no credentials, current generations or transport grant", async () => {
  const disabled: ClaudeCapabilityDescriptor = { ...value, state: "disabled", token: null, ownerGeneration: null, installationGeneration: null, origin: null };
  writeFileSync(file, encodeClaudeCapability(disabled)); expect(await readClaudeCapabilityDescriptor(file, id, value.ownerKey)).toEqual(disabled);
});
test("actual oversized, invalid UTF8 and broad-mode files refuse before adoption", async () => {
  writeFileSync(file, Buffer.alloc(CAPABILITY_LIMITS.bytes + 1)); await refusal(readClaudeCapabilityDescriptor(file, id), "unauthorized");
  writeFileSync(file, Buffer.from([0xc3, 0x28])); await refusal(readClaudeCapabilityDescriptor(file, id), "corrupt");
  writeFileSync(file, encodeClaudeCapability(value)); chmodSync(file, 0o644); await refusal(readClaudeCapabilityDescriptor(file, id), "unauthorized");
  chmodSync(file, 0o600); chmodSync(directory, 0o755); await refusal(readClaudeCapabilityDescriptor(file, id), "unauthorized");
});
test("final/ancestor symlinks, hardlinks and a FIFO cannot redirect or stall the private reader", async () => {
  const sentinel = path.join(directory, "sentinel"); writeFileSync(sentinel, "PRIVATE_TARGET", { mode: 0o600 }); rmSync(file); symlinkSync(sentinel, file);
  await refusal(readClaudeCapabilityDescriptor(file, id)); expect(readFileSync(sentinel, "utf8")).toBe("PRIVATE_TARGET");
  rmSync(file); writeFileSync(file, encodeClaudeCapability(value), { mode: 0o600 }); const alias = path.join(directory, "alias"); linkSync(file, alias); await refusal(readClaudeCapabilityDescriptor(file, id), "unauthorized"); rmSync(alias);
  const linked = path.join(directory, "linked"); symlinkSync(directory, linked); await refusal(readClaudeCapabilityDescriptor(path.join(linked, id + ".json"), id)); rmSync(linked);
  rmSync(file); expect(spawnSync("mkfifo", [file]).status).toBe(0); const started = performance.now(); await refusal(readClaudeCapabilityDescriptor(file, id)); expect(performance.now() - started).toBeLessThan(CAPABILITY_LIMITS.acquisitionMs);
});
test("cancelled acquisition returns no descriptor and leaves the current private bytes unchanged", async () => {
  const controller = new AbortController(), before = readFileSync(file, "utf8"), pending = readClaudeCapabilityDescriptor(file, id, value.ownerKey, controller.signal); controller.abort();
  await refusal(pending, "aborted"); expect(readFileSync(file, "utf8")).toBe(before); expect(await readClaudeCapabilityDescriptor(file, id, value.ownerKey)).toEqual(value);
});
test("a copied descriptor cannot be adopted at another private profile path", async () => {
  const other = path.join(directory, "custom profile"); mkdirSync(other, { mode: 0o700 }); const otherFile = path.join(other, id + ".json"); writeFileSync(otherFile, readFileSync(file), { mode: 0o600 });
  await refusal(readClaudeCapabilityDescriptor(otherFile, id, value.ownerKey), "corrupt");
  const target = { ...value, capabilityFile: otherFile, ownerKey: capabilityOwnerKey(path.join(other, "owner.sqlite")) }; writeFileSync(otherFile, encodeClaudeCapability(target));
  expect(await readClaudeCapabilityDescriptor(otherFile, id, target.ownerKey)).toEqual(target); await refusal(readClaudeCapabilityDescriptor(otherFile, id, value.ownerKey), "corrupt");
});
