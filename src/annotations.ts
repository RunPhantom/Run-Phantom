import { randomUUID } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDrizzleDb } from "./db";
import { annotations, runs, spans } from "./db/schema";
import type { AgentAnnotationSource } from "./agent-chat";

export type AnnotationKind = "issue" | "good" | "note";
export type AnnotationSource = "user" | AgentAnnotationSource;

export interface Annotation {
  id: string;
  run_id: string;
  span_id: string | null;
  kind: AnnotationKind;
  note: string | null;
  source: AnnotationSource;
  created_at: number;
}

export interface CreateAnnotationInput {
  run_id: string;
  span_id?: string | null;
  kind: AnnotationKind;
  note?: string | null;
  source: AnnotationSource;
}

const KINDS: ReadonlySet<AnnotationKind> = new Set(["issue", "good", "note"]);
const SOURCES: ReadonlySet<AnnotationSource> = new Set(["user", "claude-code", "codex"]);

export class InvalidAnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnnotationError";
  }
}

export class AnnotationNotFoundError extends Error {
  constructor(id: string) {
    super(`Annotation not found: ${id}`);
    this.name = "AnnotationNotFoundError";
  }
}

// MAX_NOTE_CHARS bounds what one annotation can cost every later reader: notes
// are inlined verbatim into the run outline, which is also an MCP tool result,
// so an unbounded note lets a single write make a run unreadable for good.
export const MAX_NOTE_CHARS = 10_000;

export function createAnnotation(input: CreateAnnotationInput): Annotation {
  if (typeof input.run_id !== "string" || !input.run_id) {
    throw new InvalidAnnotationError("run_id is required");
  }
  if (!KINDS.has(input.kind)) throw new InvalidAnnotationError(`invalid kind: ${input.kind}`);
  if (!SOURCES.has(input.source)) throw new InvalidAnnotationError(`invalid source: ${input.source}`);
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    throw new InvalidAnnotationError("note must be a string");
  }
  if (typeof input.note === "string" && input.note.length > MAX_NOTE_CHARS) {
    throw new InvalidAnnotationError(`note exceeds ${MAX_NOTE_CHARS} characters`);
  }
  // A whitespace-only note is an empty annotation: it renders as "(no note)" and
  // carries nothing the author meant to record, so it is a mis-save rather than
  // a deliberate one. "issue" and "good" are still meaningful without a note;
  // "note" is not.
  const note = typeof input.note === "string" ? input.note.trim() : null;
  if (input.kind === "note" && !note) {
    throw new InvalidAnnotationError("a note annotation needs a note");
  }

  // The referenced rows are checked because nothing else does: annotations carry
  // no foreign key, so a typo'd or hallucinated id was accepted with 201 and then
  // silently never rendered — the write looked successful and the note was gone.
  const db = getDrizzleDb();
  const runExists = db.select({ id: runs.id }).from(runs).where(eq(runs.id, input.run_id)).get();
  if (!runExists) throw new InvalidAnnotationError(`unknown run_id: ${input.run_id}`);

  // Empty string is not "no span" — it is a span id that cannot match anything.
  let spanId: string | null = null;
  if (input.span_id !== undefined && input.span_id !== null) {
    if (typeof input.span_id !== "string" || !input.span_id) {
      throw new InvalidAnnotationError("span_id must be a non-empty string when provided");
    }
    const spanExists = db
      .select({ id: spans.id })
      .from(spans)
      .where(and(eq(spans.id, input.span_id), eq(spans.run_id, input.run_id)))
      .get();
    if (!spanExists) {
      throw new InvalidAnnotationError(`unknown span_id ${input.span_id} in run ${input.run_id}`);
    }
    spanId = input.span_id;
  }

  const row: Annotation = {
    id: randomUUID(),
    run_id: input.run_id,
    span_id: spanId,
    kind: input.kind,
    note: note || null,
    source: input.source,
    created_at: Date.now(),
  };
  getDrizzleDb().insert(annotations).values(row).run();
  return row;
}

export function deleteAnnotation(id: string): Annotation {
  const removed = getDrizzleDb()
    .delete(annotations)
    .where(eq(annotations.id, id))
    .returning()
    .get();
  if (!removed) throw new AnnotationNotFoundError(id);
  return removed;
}

export function getAnnotationsByRun(runId: string): Annotation[] {
  return getDrizzleDb()
    .select()
    .from(annotations)
    .where(eq(annotations.run_id, runId))
    .orderBy(asc(annotations.created_at), asc(annotations.id))
    .all();
}
