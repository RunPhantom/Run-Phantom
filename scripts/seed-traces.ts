#!/usr/bin/env tsx
/**
 * Seed a running runphantom backend with a small library of representative
 * AI-agent traces. The fixtures are static and deterministic — re-running is
 * idempotent because run/span IDs don't change.
 *
 * Usage:
 *   bun run seed:traces                               # POSTs to http://localhost:5947
 *   RUNPHANTOM_URL=http://localhost:5998 bun run seed:traces
 *
 * The fixtures are also exported so tests can import them directly instead of
 * going through HTTP.
 */


type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number };
type Attr = { key: string; value: AttrValue };

const str = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): Attr => ({ key, value: { intValue: String(v) } });

// `RUNPHANTOM_SEED_SALT` lets the smoke runner generate distinct trace IDs
// across consecutive seeds against the same DB. Default 0 keeps the stable
// 0..0001 / 0..0002 / 0..0003 IDs used by the deterministic smoke fixtures.
const SALT = Number(process.env.RUNPHANTOM_SEED_SALT ?? 0) || 0;
const traceId = (n: number) => (n + SALT).toString(16).padStart(32, "0");
const spanId = (trace: number, slot: number) =>
  `${(trace + SALT).toString(16).padStart(8, "0")}${slot.toString(16).padStart(8, "0")}`;
const nano = (ms: number) => String(BigInt(ms) * 1_000_000n);

interface SpanSeed {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  statusCode?: 1 | 2; // 1=OK, 2=ERROR
  attrs: Attr[];
}

function buildOtlpBody(tid: string, spans: SpanSeed[]) {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: spans.map((s) => ({
              traceId: tid,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId,
              name: s.name,
              kind: 1,
              startTimeUnixNano: nano(s.startMs),
              endTimeUnixNano: nano(s.endMs),
              status: s.statusCode ? { code: s.statusCode } : undefined,
              attributes: s.attrs,
            })),
          },
        ],
      },
    ],
  };
}

// Common attributes that identify a run so the UI can group + filter
function runMeta(eventName: string, convoId: string, userId = "demo-user"): Attr[] {
  return [
    str("ai.telemetry.metadata.runphantom.eventName", eventName),
    str("ai.telemetry.metadata.runphantom.userId", userId),
    str("ai.telemetry.metadata.runphantom.convoId", convoId),
  ];
}

function llmAttrs(prompt: unknown, response: string, inTok: number, outTok: number): Attr[] {
  return [
    str("ai.operationId", "ai.generateText"),
    str("ai.model.id", "claude-sonnet-4-5"),
    str("ai.model.provider", "anthropic"),
    str("ai.prompt", JSON.stringify(prompt)),
    str("ai.response.text", response),
    int("ai.usage.inputTokens", inTok),
    int("ai.usage.outputTokens", outTok),
  ];
}

function toolAttrs(name: string, args: unknown, result: string): Attr[] {
  return [
    str("ai.operationId", "ai.toolCall"),
    str("ai.toolCall.name", name),
    str("ai.toolCall.args", JSON.stringify(args)),
    str("ai.toolCall.result", result),
  ];
}


// Pin the clock so re-running doesn't churn timestamps.
const T0 = 1_776_000_000_000;

/**
 * 1. Happy path — read a file, decide on an edit, apply the edit. Every span OK.
 */
function fixtureSuccessfulEdit() {
  const tid = traceId(1);
  const rt = spanId(1, 1);
  const meta = runMeta("code-agent", "demo-convo-readme");
  const t = T0;

  return {
    name: "successful edit",
    traceId: tid,
    body: buildOtlpBody(tid, [
      {
        spanId: rt, name: "agent.turn",
        startMs: t, endMs: t + 3200, statusCode: 1,
        attrs: [
          ...meta,
          str("traceloop.entity.input", "Fix the typo in README.md"),
          str("traceloop.entity.output", "Changed 'traec viewer' to 'trace viewer' on line 3."),
        ],
      },
      {
        spanId: spanId(1, 2), parentSpanId: rt, name: "llm.generate",
        startMs: t + 10, endMs: t + 480, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "user", content: "Fix the typo in README.md" }] },
            "I'll read the file first to find the typo.",
            42, 14,
          ),
        ],
      },
      {
        spanId: spanId(1, 3), parentSpanId: rt, name: "ai.toolCall",
        startMs: t + 495, endMs: t + 520, statusCode: 1,
        attrs: [
          ...meta,
          ...toolAttrs("read_file", { path: "README.md" }, "# Run Phantom\n\nA traec viewer for AI agents.\n"),
        ],
      },
      {
        spanId: spanId(1, 4), parentSpanId: rt, name: "llm.generate",
        startMs: t + 540, endMs: t + 1800, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "user", content: "Found 'traec' on line 3 — should be 'trace'." }] },
            "I'll apply the edit now.",
            88, 12,
          ),
        ],
      },
      {
        spanId: spanId(1, 5), parentSpanId: rt, name: "ai.toolCall",
        startMs: t + 1820, endMs: t + 1860, statusCode: 1,
        attrs: [
          ...meta,
          ...toolAttrs(
            "edit_file",
            { path: "README.md", old_string: "traec viewer", new_string: "trace viewer" },
            "edit applied",
          ),
        ],
      },
      {
        spanId: spanId(1, 6), parentSpanId: rt, name: "llm.generate",
        startMs: t + 1900, endMs: t + 3180, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "assistant", content: "edit applied" }] },
            "Fixed the typo on line 3. 'traec viewer' → 'trace viewer'.",
            110, 24,
          ),
        ],
      },
    ]),
  };
}

/**
 * 2. Tool failure + recovery — first bash invocation errors, agent reads the
 *    error, retries with a corrected command, finishes OK. Tests the UI's
 *    handling of mid-trace failures.
 */
function fixtureToolRecovery() {
  const tid = traceId(2);
  const rt = spanId(2, 1);
  const meta = runMeta("code-agent", "demo-convo-readme");
  const t = T0 + 5_000;

  return {
    name: "tool failure + recovery",
    traceId: tid,
    body: buildOtlpBody(tid, [
      {
        spanId: rt, name: "agent.turn",
        startMs: t, endMs: t + 2700, statusCode: 1,
        attrs: [
          ...meta,
          str("traceloop.entity.input", "Run the tests"),
          str("traceloop.entity.output", "Tests pass after switching from `npm test` to `pnpm test`."),
        ],
      },
      {
        spanId: spanId(2, 2), parentSpanId: rt, name: "llm.generate",
        startMs: t + 10, endMs: t + 420, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "user", content: "Run the tests" }] },
            "Running `npm test`.",
            30, 6,
          ),
        ],
      },
      {
        spanId: spanId(2, 3), parentSpanId: rt, name: "ai.toolCall",
        startMs: t + 440, endMs: t + 700, statusCode: 2,
        attrs: [
          ...meta,
          ...toolAttrs(
            "bash",
            { command: "npm test" },
            "npm error: This project uses pnpm. Use `pnpm test` instead.\nexit 1",
          ),
        ],
      },
      {
        spanId: spanId(2, 4), parentSpanId: rt, name: "llm.generate",
        startMs: t + 720, endMs: t + 1400, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "tool", content: "npm error: use pnpm instead" }] },
            "Switching to pnpm.",
            74, 7,
          ),
        ],
      },
      {
        spanId: spanId(2, 5), parentSpanId: rt, name: "ai.toolCall",
        startMs: t + 1420, endMs: t + 2200, statusCode: 1,
        attrs: [
          ...meta,
          ...toolAttrs(
            "bash",
            { command: "pnpm test" },
            "Test Files  8 passed (8)\nTests  48 passed (48)",
          ),
        ],
      },
      {
        spanId: spanId(2, 6), parentSpanId: rt, name: "llm.generate",
        startMs: t + 2220, endMs: t + 2680, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "tool", content: "8 test files, 48 tests passed" }] },
            "All 48 tests pass.",
            112, 9,
          ),
        ],
      },
    ]),
  };
}

/**
 * 3. Sub-agent — main agent spawns a code-review sub-agent. The subagent has
 *    its own LLM + tool children under a parent span named "subagent.review".
 *    Exercises the AgentGraph view.
 */
function fixtureSubAgent() {
  const tid = traceId(3);
  const rt = spanId(3, 1);
  const sub = spanId(3, 4);
  const meta = runMeta("code-agent", "demo-convo-review");
  const t = T0 + 10_000;

  return {
    name: "sub-agent review",
    traceId: tid,
    body: buildOtlpBody(tid, [
      {
        spanId: rt, name: "agent.turn",
        startMs: t, endMs: t + 4500, statusCode: 1,
        attrs: [
          ...meta,
          str("traceloop.entity.input", "Review the auth refactor in PR #42"),
          str("traceloop.entity.output", "LGTM — one minor nit about the retry loop in auth/session.ts:57."),
        ],
      },
      {
        spanId: spanId(3, 2), parentSpanId: rt, name: "llm.generate",
        startMs: t + 10, endMs: t + 600, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "user", content: "Review the auth refactor in PR #42" }] },
            "I'll grab the diff, then hand it to the reviewer agent.",
            38, 16,
          ),
        ],
      },
      {
        spanId: spanId(3, 3), parentSpanId: rt, name: "ai.toolCall",
        startMs: t + 620, endMs: t + 900, statusCode: 1,
        attrs: [
          ...meta,
          ...toolAttrs(
            "bash",
            { command: "git diff main...HEAD -- auth/" },
            "diff --git a/auth/session.ts b/auth/session.ts\n@@ -50,5 +50,10 @@\n+  // retry up to 3 times\n",
          ),
        ],
      },
      {
        spanId: sub, parentSpanId: rt, name: "subagent.review",
        startMs: t + 950, endMs: t + 4100, statusCode: 1,
        attrs: [
          ...meta,
          str("runphantom.subagent.name", "code-reviewer"),
          str("traceloop.entity.input", "Review this diff for auth/session.ts"),
          str("traceloop.entity.output", "LGTM, one nit at line 57."),
        ],
      },
      {
        spanId: spanId(3, 5), parentSpanId: sub, name: "llm.generate",
        startMs: t + 970, endMs: t + 2800, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "user", content: "Review this auth diff" }] },
            "Looking at the retry loop — no exponential backoff.",
            220, 18,
          ),
        ],
      },
      {
        spanId: spanId(3, 6), parentSpanId: sub, name: "ai.toolCall",
        startMs: t + 2820, endMs: t + 2980, statusCode: 1,
        attrs: [
          ...meta,
          ...toolAttrs(
            "read_file",
            { path: "auth/session.ts", start_line: 40, end_line: 70 },
            "50: function connect() {\n57:   for (let i = 0; i < 3; i++) { ... }\n",
          ),
        ],
      },
      {
        spanId: spanId(3, 7), parentSpanId: sub, name: "llm.generate",
        startMs: t + 3000, endMs: t + 4080, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "tool", content: "session.ts:57 retry loop" }] },
            "LGTM. Nit at span_id: 0000000300000006 — consider backoff.",
            310, 22,
          ),
        ],
      },
      {
        spanId: spanId(3, 8), parentSpanId: rt, name: "llm.generate",
        startMs: t + 4130, endMs: t + 4480, statusCode: 1,
        attrs: [
          ...meta,
          ...llmAttrs(
            { messages: [{ role: "tool", content: "reviewer: LGTM with one nit" }] },
            "Review done. LGTM with a small note about retry backoff.",
            420, 14,
          ),
        ],
      },
    ]),
  };
}

const FIXTURES = [fixtureSuccessfulEdit, fixtureToolRecovery, fixtureSubAgent];


async function main() {
  const url = process.env.RUNPHANTOM_URL ?? "http://localhost:5947";
  console.log(`→ seeding ${FIXTURES.length} traces to ${url}`);
  for (const make of FIXTURES) {
    const fx = make();
    const res = await fetch(`${url}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fx.body),
    });
    if (!res.ok) {
      console.error(`✗ ${fx.name}: ${res.status} ${await res.text()}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ ${fx.name.padEnd(26)} traceId=${fx.traceId}`);
  }
  console.log(`\nOpen ${url} to see them in the runs list.`);
}

// Only run main when invoked directly (not when imported by tests).
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
