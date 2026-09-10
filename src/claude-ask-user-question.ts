import { randomUUID } from "crypto";

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionPrompt {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface ParsedAskUserQuestionHook {
  sessionId: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  questions: AskUserQuestionPrompt[];
}

export interface PublicAskUserQuestion {
  id: string;
  session_id: string;
  tool_use_id: string;
  questions: AskUserQuestionPrompt[];
  created_at: string;
}

interface PendingAskUserQuestion extends PublicAskUserQuestion {
  resolve: (answers: Record<string, string> | null) => void;
}

type Broadcast = (event: string, data: unknown) => void;

export class AskUserQuestionBridge {
  private pending = new Map<string, PendingAskUserQuestion>();

  constructor(private broadcast: Broadcast) {}

  active(): PublicAskUserQuestion[] {
    return [...this.pending.values()].map(publicQuestion);
  }

  ask(input: ParsedAskUserQuestionHook): Promise<Record<string, string> | null> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const pending: PendingAskUserQuestion = {
        id,
        session_id: input.sessionId,
        tool_use_id: input.toolUseId,
        questions: input.questions,
        created_at: new Date().toISOString(),
        resolve,
      };
      this.pending.set(id, pending);
      this.broadcast("claude_ask_user_question", publicQuestion(pending));
    });
  }

  answer(id: string, answers: Record<string, string>): boolean {
    return this.finish(id, answers);
  }

  closeAll(): void {
    for (const id of this.pending.keys()) this.finish(id, null, "server_closed");
  }

  private finish(id: string, answers: Record<string, string> | null, reason?: string): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    pending.resolve(answers);
    this.broadcast("claude_ask_user_question_resolved", { id, reason: reason ?? null });
    return true;
  }
}

export function parseAskUserQuestionHookInput(body: unknown): ParsedAskUserQuestionHook | null {
  const hookInput = objectValue(body);
  if (!hookInput) return null;
  if (hookInput.hook_event_name !== "PreToolUse" || hookInput.tool_name !== "AskUserQuestion") return null;
  const toolInput = objectValue(hookInput.tool_input);
  const questions = parseAskUserQuestions(toolInput?.questions);
  if (!toolInput || questions.length === 0) return null;
  return {
    sessionId: stringValue(hookInput.session_id) ?? "unknown",
    toolUseId: stringValue(hookInput.tool_use_id) ?? randomUUID(),
    toolInput,
    questions,
  };
}

export function parseAnswerMap(value: unknown): Record<string, string> | null {
  const raw = objectValue(value);
  if (!raw) return null;
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(raw)) {
    if (typeof answer !== "string") continue;
    const trimmedQuestion = question.trim();
    const trimmedAnswer = answer.trim();
    if (!trimmedQuestion || !trimmedAnswer) continue;
    answers[trimmedQuestion] = trimmedAnswer;
  }
  return Object.keys(answers).length ? answers : null;
}

export function askUserQuestionAllow(toolInput: Record<string, unknown>, answers: Record<string, string>) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...toolInput, answers },
    },
  };
}

export function askUserQuestionDeny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function publicQuestion(pending: PendingAskUserQuestion): PublicAskUserQuestion {
  return {
    id: pending.id,
    session_id: pending.session_id,
    tool_use_id: pending.tool_use_id,
    questions: pending.questions,
    created_at: pending.created_at,
  };
}

function parseAskUserQuestions(value: unknown): AskUserQuestionPrompt[] {
  if (!Array.isArray(value)) return [];
  const questions: AskUserQuestionPrompt[] = [];
  for (const rawQuestion of value) {
    const question = objectValue(rawQuestion);
    if (!question) continue;
    const questionText = stringValue(question.question);
    const options = parseAskUserQuestionOptions(question.options);
    if (!questionText || options.length === 0) continue;
    questions.push({
      question: questionText,
      header: stringValue(question.header) ?? undefined,
      multiSelect: question.multiSelect === true,
      options,
    });
  }
  return questions;
}

function parseAskUserQuestionOptions(value: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: AskUserQuestionOption[] = [];
  for (const rawOption of value) {
    const option = objectValue(rawOption);
    if (!option) continue;
    const label = stringValue(option.label);
    if (!label) continue;
    options.push({
      label,
      description: stringValue(option.description) ?? undefined,
    });
  }
  return options;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
