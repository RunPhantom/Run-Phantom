import { randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { getDrizzleDb, getRunById } from "../db";
import { verification_snapshots } from "../db/schema";
import { validateOrigin } from "./validation";
import { redactText } from "./serialization";
import { closedRecord, jsonBytes, parseSemanticTree, SNAPSHOT_LIMITS, SnapshotInputError, snapshotArray, snapshotInteger, snapshotText, type PortableSnapshots, type SavedSemanticSnapshot, type SemanticTreeResult } from "./snapshot-contract";
import { diffSnapshots, snapshotDigests } from "./snapshot-diff";

type Row = typeof verification_snapshots.$inferSelect;
const digestPattern = /^[a-f0-9]{64}$/;
function safeText(value: unknown, max: number): string {
  const text = snapshotText(value, max);
  if (redactText(text) !== text) throw new SnapshotInputError("Snapshot evidence contains credentials");
  return text;
}
function name(value: unknown): string { const output = safeText(value, 128).trim(); if (!output) throw new SnapshotInputError("A snapshot name is required"); return output; }
function origin(value: unknown): string { const output = validateOrigin(safeText(value, 2048)); if (output !== value) throw new SnapshotInputError("Snapshot origin must be canonical"); return output; }
function privacy(tree: SemanticTreeResult): void {
  for (const node of tree.nodes) for (const field of ["tag", "role", "name", "label", "testId"] as const) safeText(node[field], SNAPSHOT_LIMITS.text);
  for (const unread of tree.coverage.unread) safeText(unread.tag, SNAPSHOT_LIMITS.text);
}
function decode(row: Row): SavedSemanticSnapshot {
  try {
    if (Buffer.byteLength(row.payload) > SNAPSHOT_LIMITS.payloadBytes) throw new SnapshotInputError("Stored snapshot exceeds its payload budget", 413);
    const wrapper = closedRecord(JSON.parse(row.payload), ["formatVersion", "tree", "connectionGeneration"]);
    if (wrapper.formatVersion !== 1) throw new SnapshotInputError("Unsupported stored snapshot wrapper");
    const tree = parseSemanticTree(wrapper.tree); privacy(tree);
    const connectionGeneration = wrapper.connectionGeneration === null ? null : snapshotInteger(wrapper.connectionGeneration);
    if (row.source === "paired-sdk" ? !row.session_id || !connectionGeneration : row.source !== "imported-evidence" || row.session_id !== null || connectionGeneration !== null) throw new SnapshotInputError("Invalid stored snapshot provenance");
    const digests = snapshotDigests(tree);
    if (row.content_sha256 !== digests.contentDigest || row.coverage_sha256 !== digests.coverageDigest) throw new SnapshotInputError("Stored snapshot digest mismatch");
    return { id: safeText(row.id, 128), runId: row.run_id, sessionId: row.session_id, name: name(row.name), origin: origin(row.origin), capturedAt: snapshotInteger(row.captured_at), storedAt: snapshotInteger(row.stored_at), source: row.source, connectionGeneration, tree, ...digests };
  } catch {
    throw new SnapshotInputError("Stored semantic snapshot is unavailable or corrupt", 409);
  }
}
function row(snapshot: SavedSemanticSnapshot): typeof verification_snapshots.$inferInsert {
  const payload = JSON.stringify({ formatVersion: 1, tree: snapshot.tree, connectionGeneration: snapshot.connectionGeneration });
  if (Buffer.byteLength(payload) > SNAPSHOT_LIMITS.payloadBytes) throw new SnapshotInputError("Snapshot payload exceeds its byte budget", 413);
  return { id: snapshot.id, run_id: snapshot.runId, session_id: snapshot.sessionId, name: snapshot.name, origin: snapshot.origin, captured_at: snapshot.capturedAt, stored_at: snapshot.storedAt, source: snapshot.source, content_sha256: snapshot.contentDigest, coverage_sha256: snapshot.coverageDigest, payload };
}
function insertAll(snapshots: SavedSemanticSnapshot[]): SavedSemanticSnapshot[] {
  const rows = snapshots.map(row);
  getDrizzleDb().transaction(tx => {
    if ((tx.select({ n: count() }).from(verification_snapshots).get()?.n ?? 0) + rows.length > SNAPSHOT_LIMITS.records) throw new SnapshotInputError("Saved snapshot limit reached; delete a snapshot first", 409);
    tx.insert(verification_snapshots).values(rows).run();
  });
  return snapshots;
}
export function saveCapturedSnapshot(input: { sessionId: string; runId: string | null; name: unknown; origin: string; tree: unknown; connectionGeneration: number; capturedAt: number }): SavedSemanticSnapshot {
  const tree = parseSemanticTree(input.tree); privacy(tree);
  const generation = snapshotInteger(input.connectionGeneration);
  if (!generation) throw new SnapshotInputError("Capture has no live generation", 409);
  if (input.runId && !getRunById(input.runId)) throw new SnapshotInputError("Capture run no longer exists", 409);
  const snapshot: SavedSemanticSnapshot = { id: randomUUID(), runId: input.runId, sessionId: safeText(input.sessionId, 128), name: name(input.name), origin: origin(input.origin), capturedAt: snapshotInteger(input.capturedAt), storedAt: Date.now(), source: "paired-sdk", connectionGeneration: generation, tree, ...snapshotDigests(tree) };
  return insertAll([snapshot])[0];
}
export function listSnapshots(filter: { runId?: string; origin?: string } = {}): SavedSemanticSnapshot[] {
  const conditions = [filter.runId === undefined ? undefined : eq(verification_snapshots.run_id, safeText(filter.runId, 128)), filter.origin === undefined ? undefined : eq(verification_snapshots.origin, origin(filter.origin))].filter(item => item !== undefined);
  return getDrizzleDb().select().from(verification_snapshots).where(and(...conditions)).orderBy(desc(verification_snapshots.stored_at), desc(verification_snapshots.id)).limit(SNAPSHOT_LIMITS.records).all().map(decode);
}
export function getSnapshot(id: unknown): SavedSemanticSnapshot {
  const found = getDrizzleDb().select().from(verification_snapshots).where(eq(verification_snapshots.id, safeText(id, 128))).get();
  if (!found) throw new SnapshotInputError("Semantic snapshot not found", 404);
  return decode(found);
}
export function deleteSnapshot(id: unknown): void {
  const identity = safeText(id, 128);
  const found = getDrizzleDb().select({ id: verification_snapshots.id }).from(verification_snapshots).where(eq(verification_snapshots.id, identity)).get();
  if (!found) throw new SnapshotInputError("Semantic snapshot not found", 404);
  // Explicit deletion is also the recovery path for a corrupt immutable payload.
  getDrizzleDb().delete(verification_snapshots).where(eq(verification_snapshots.id, identity)).run();
}
export function compareSnapshots(beforeId: unknown, afterId: unknown) {
  const before = getSnapshot(beforeId); const after = getSnapshot(afterId);
  if (before.origin !== after.origin || before.tree.formatVersion !== after.tree.formatVersion || before.tree.nameModel !== after.tree.nameModel) throw new SnapshotInputError("Snapshot origin or model does not match", 409);
  return diffSnapshots(before.tree, after.tree, before.id, after.id);
}
export function exportSnapshots(idsValue: unknown): PortableSnapshots {
  const ids = snapshotArray(idsValue, SNAPSHOT_LIMITS.transferEntries).map(id => safeText(id, 128));
  if (!ids.length || new Set(ids).size !== ids.length) throw new SnapshotInputError("Choose one or two distinct snapshots");
  // Resolve every row before exposing any portable evidence. Corrupt rows refuse the transfer.
  const entries = ids.map(id => { const snapshot = getSnapshot(id); return { name: snapshot.name, origin: snapshot.origin, capturedAt: snapshot.capturedAt, tree: snapshot.tree, contentDigest: snapshot.contentDigest, coverageDigest: snapshot.coverageDigest }; });
  const artifact: PortableSnapshots = { format: "runphantom-semantic-snapshots/v1", entries };
  if (jsonBytes(artifact) > SNAPSHOT_LIMITS.transferBytes) throw new SnapshotInputError("Snapshot transfer exceeds its byte budget", 413);
  return artifact;
}
export function importSnapshots(value: unknown, runId?: unknown): SavedSemanticSnapshot[] {
  const artifact = closedRecord(value, ["format", "entries"]);
  if (artifact.format !== "runphantom-semantic-snapshots/v1") throw new SnapshotInputError("Unsupported snapshot transfer format");
  const entries = snapshotArray(artifact.entries, SNAPSHOT_LIMITS.transferEntries);
  if (!entries.length) throw new SnapshotInputError("Snapshot transfer requires one or two entries");
  const localRunId = runId === undefined ? null : safeText(runId, 128);
  if (localRunId !== null && !getRunById(localRunId)) throw new SnapshotInputError("Import target run not found", 404);
  const snapshots = entries.map(value => {
    const entry = closedRecord(value, ["name", "origin", "capturedAt", "tree", "contentDigest", "coverageDigest"]);
    const tree = parseSemanticTree(entry.tree); privacy(tree);
    const digests = snapshotDigests(tree);
    if (!digestPattern.test(snapshotText(entry.contentDigest, 64)) || !digestPattern.test(snapshotText(entry.coverageDigest, 64)) || entry.contentDigest !== digests.contentDigest || entry.coverageDigest !== digests.coverageDigest) throw new SnapshotInputError("Snapshot transfer digest mismatch");
    return { id: randomUUID(), runId: localRunId, sessionId: null, name: name(entry.name), origin: origin(entry.origin), capturedAt: snapshotInteger(entry.capturedAt), storedAt: Date.now(), source: "imported-evidence" as const, connectionGeneration: null, tree, ...digests };
  });
  if (jsonBytes({ format: artifact.format, entries: snapshots.map(snapshot => ({ name: snapshot.name, origin: snapshot.origin, capturedAt: snapshot.capturedAt, tree: snapshot.tree, contentDigest: snapshot.contentDigest, coverageDigest: snapshot.coverageDigest })) }) > SNAPSHOT_LIMITS.transferBytes) throw new SnapshotInputError("Snapshot transfer exceeds its byte budget", 413);
  return insertAll(snapshots);
}
