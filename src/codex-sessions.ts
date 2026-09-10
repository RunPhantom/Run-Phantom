import fs from "fs";
import os from "os";
import path from "path";
import { readSessionFileSync, sortByMtimeDesc } from "./read-bounded";
import type {
  ClaudeChatMessage,
  ClaudeChatMessageBlock,
  ClaudeSessionDetail,
  ClaudeSessionSummary,
} from "./claude-sessions";

const MAX_SESSION_FILES = 300;

// Parsing every session transcript to build this list costs seconds of blocking
// I/O on a large ~/.codex store, and the UI requests it on every page load. The
// file set is keyed by its own stat signature, so writing or adding a session
// invalidates the entry immediately — this trades no freshness for the work.
let sessionListCache: { signature: string; byCwd: Map<string, ClaudeSessionSummary[]> } | null = null;

export function listCodexSessions(cwd: string): ClaudeSessionSummary[] {
  const files = codexSessionFiles();
  const signature = statSignature(files);

  if (sessionListCache?.signature === signature) {
    const hit = sessionListCache.byCwd.get(cwd);
    if (hit) return hit;
  } else {
    sessionListCache = { signature, byCwd: new Map() };
  }

  const sessions = dedupeById(
    files
      .map((file) => readCodexSessionFile(file))
      .filter((session): session is ClaudeSessionDetail =>
        // A rollout file with no messages has nothing to show and nothing to
        // resume; listing them made most of the picker unopenable rows.
        !!session && session.cwd === cwd && session.message_count > 0)
      .sort((a, b) => (Date.parse(b.updated_at ?? "") || 0) - (Date.parse(a.updated_at ?? "") || 0)),
  ).map(({ messages: _messages, ...summary }) => summary);

  sessionListCache.byCwd.set(cwd, sessions);
  return sessions;
}

/**
 * One row per session id, newest first.
 *
 * Codex writes a fresh rollout file every time a session is resumed and they all
 * carry the same session_meta id, so the picker showed the same conversation
 * many times over. Only one of those rows could ever open — getCodexSession
 * matches on id and returns the first file it finds — so every duplicate was a
 * row that silently failed on click. Input is already sorted newest-first, so
 * the first occurrence is the one to keep.
 */
function dedupeById(sessions: ClaudeSessionDetail[]): ClaudeSessionDetail[] {
  const seen = new Set<string>();
  const out: ClaudeSessionDetail[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    out.push(session);
  }
  return out;
}

function statSignature(files: string[]): string {
  let newest = 0;
  for (const file of files) {
    try {
      const { mtimeMs } = fs.statSync(file);
      if (mtimeMs > newest) newest = mtimeMs;
    } catch { /* vanished between listing and stat */ }
  }
  return `${files.length}:${newest}`;
}

export function getCodexSession(cwd: string, sessionId: string): ClaudeSessionDetail | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  // Several rollout files can carry this id (one per resume). The list shows the
  // newest by updated_at, so resolve by the same rule — picking by file order
  // instead could open a different transcript than the row that was clicked.
  let best: ClaudeSessionDetail | null = null;
  let bestAt = -Infinity;
  for (const file of codexSessionFiles()) {
    if (!path.basename(file).includes(sessionId)) continue;
    const session = readCodexSessionFile(file);
    if (session?.cwd !== cwd || session.id !== sessionId) continue;
    const at = Date.parse(session.updated_at ?? "") || 0;
    if (at > bestAt) { best = session; bestAt = at; }
  }
  return best;
}

function codexSessionFiles(): string[] {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const files: string[] = [];
  collectJsonlFiles(root, files);
  return sortByMtimeDesc(files).slice(0, MAX_SESSION_FILES);
}

function collectJsonlFiles(dir: string, files: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(next, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(next);
  }
}

function readCodexSessionFile(filePath: string): ClaudeSessionDetail | null {
  if (!fs.existsSync(filePath)) return null;
  const messages: ClaudeChatMessage[] = [];
  const toolBlocks = new Map<string, Extract<ClaudeChatMessageBlock, { type: "tool" }>>();
  let id = "";
  let cwd = "";
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let lastPrompt: string | null = null;
  let runPhantomTurnOpen = false;
  let assistantBlocks: ClaudeChatMessageBlock[] = [];
  let assistantTimestamp: string | null = null;

  const flushAssistant = () => {
    if (!assistantBlocks.length) return;
    const content = assistantBlocksText(assistantBlocks);
    if (content.trim()) {
      messages.push({
        id: `${id || path.basename(filePath, ".jsonl")}-${messages.length}`,
        role: "assistant",
        content,
        blocks: assistantBlocks,
        timestamp: assistantTimestamp,
      });
    }
    assistantBlocks = [];
    assistantTimestamp = null;
  };

  const raw = readSessionFileSync(filePath);
  if (raw === null) return null;
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const event = parseLine(line);
    if (!event) continue;
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
    }

    if (event.type === "session_meta") {
      const payload = objectValue(event.payload);
      if (typeof payload?.id === "string") id = payload.id;
      if (typeof payload?.cwd === "string") cwd = payload.cwd;
      continue;
    }

    if (event.type !== "response_item") continue;
    const payload = objectValue(event.payload);
    if (!payload) continue;

    if (payload.type === "message") {
      const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
      if (!role) continue;
      const rawContent = contentText(payload.content);
      if (role === "user") {
        flushAssistant();
        if (!isRunPhantomUserMessage(rawContent)) {
          runPhantomTurnOpen = false;
          continue;
        }
        const content = stripRunPhantomContext(rawContent);
        if (!content.trim()) continue;
        lastPrompt = content;
        runPhantomTurnOpen = true;
        messages.push({
          id: `${id || path.basename(filePath, ".jsonl")}-${messages.length}`,
          role,
          content,
          blocks: [{ type: "text", text: content }],
          timestamp,
        });
        continue;
      }

      if (!runPhantomTurnOpen) continue;
      const content = stripRunPhantomContext(rawContent);
      if (!content.trim()) continue;
      assistantBlocks.push({ type: "text", text: content });
      assistantTimestamp ??= timestamp;
      continue;
    }

    if (!runPhantomTurnOpen) continue;
    if (payload.type === "function_call") {
      const callId = stringValue(payload.call_id) ?? `${messages.length}-${assistantBlocks.length}`;
      const block: Extract<ClaudeChatMessageBlock, { type: "tool" }> = {
        type: "tool",
        id: callId,
        name: codexToolName(payload),
        input_preview: previewText(stringValue(payload.arguments)) ?? undefined,
      };
      toolBlocks.set(callId, block);
      assistantBlocks.push(block);
      assistantTimestamp ??= timestamp;
      continue;
    }

    if (payload.type === "function_call_output") {
      const callId = stringValue(payload.call_id);
      const block = callId ? toolBlocks.get(callId) : null;
      if (block) {
        block.ok = true;
        block.output_preview = previewText(stringValue(payload.output)) ?? undefined;
      }
    }
  }
  flushAssistant();

  if (!id || !cwd) return null;
  const previewMessage = [...messages].reverse().find((message) => message.role === "user") ?? messages[messages.length - 1];
  return {
    id,
    path: filePath,
    cwd,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: messages.length,
    last_prompt: lastPrompt,
    preview: previewText(lastPrompt || previewMessage?.content || null),
    messages,
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const typed = objectValue(part);
      return typeof typed?.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isRunPhantomUserMessage(content: string): boolean {
  return content.includes("<runphantom_message>");
}

function stripRunPhantomContext(content: string): string {
  const envelopeIndex = content.indexOf("<runphantom_message>");
  if (envelopeIndex >= 0) {
    return content.slice(envelopeIndex).replace(/^<runphantom_message>[\s\S]*?<\/runphantom_message>\s*/m, "").trim();
  }
  return content.trim();
}

function previewText(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function assistantBlocksText(blocks: ClaudeChatMessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      return `[tool: ${block.name}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function codexToolName(payload: Record<string, unknown>): string {
  const name = stringValue(payload.name) ?? "tool";
  const namespace = stringValue(payload.namespace);
  if (namespace === "mcp__runphantom__") return `runphantom.${name}`;
  return namespace ? `${namespace}.${name}` : name;
}
