/**
 * Demo traces: realistic-looking fixtures the user can stream into an empty
 * Run Phantom with one click. The fixtures mimic Vercel AI SDK span shapes so the
 * existing normalizer renders them like a real trace — same prompt/tool-call/
 * response views, no special UI paths.
 *
 * Each fixture is a typed plan: a root run + an ordered list of spans + a
 * sprinkle of live events. Replays use the same tables and shapes real
 * ingestion produces, with no special UI path.
 */
import { upsertRun, insertSpan, upsertLiveEvent, deleteRun } from "./db";

type BroadcastFn = (event: string, data: unknown) => void;

interface DemoSpan {
  id: string;
  parentId?: string;
  name: string;
  spanType: "AGENT_ROOT" | "LLM_GENERATION" | "TOOL_CALL";
  /** Milliseconds from run start when this span begins. */
  startOffsetMs: number;
  /** Milliseconds from run start when this span ends. */
  endOffsetMs: number;
  status?: "OK" | "ERROR";
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** AI SDK-flavored attributes; this is what the normalizer reads. */
  attributes?: Record<string, string | number>;
  inputPayload?: string;
  outputPayload?: string;
}

interface DemoLiveEvent {
  /** Which span this delta belongs to (matches DemoSpan.id). */
  spanId: string;
  type: "text_delta" | "reasoning_delta" | "tool_start" | "tool_result";
  content: string;
  metadata?: Record<string, unknown>;
  /** Milliseconds from run start when this event fires. */
  atOffsetMs: number;
}

interface DemoFixture {
  /** Stable string the streaming code uses for the run id (uuid'd at play time). */
  slug: string;
  name: string;
  eventName: string;
  userId?: string;
  convoId?: string;
  spans: DemoSpan[];
  liveEvents: DemoLiveEvent[];
}

const TRIAGE_AGENT: DemoFixture = {
  slug: "triage",
  name: "Customer support triage",
  eventName: "triage_agent",
  userId: "user_07h2",
  convoId: "convo_31fa",
  spans: [
    {
      id: "root",
      name: "triage_agent",
      spanType: "AGENT_ROOT",
      startOffsetMs: 0,
      endOffsetMs: 5200,
      status: "OK",
      inputPayload: "User reports their export keeps timing out at 30s. Plan account: Pro. Last login: 2h ago.",
      outputPayload: "Routed to billing-team with a prepared upgrade note and ticket sup-1842. Reason: the 30s timeout matches the Pro export limit; the account is eligible for Team.",
    },
    {
      id: "llm-1",
      parentId: "root",
      name: "ai.generateText",
      spanType: "LLM_GENERATION",
      startOffsetMs: 50,
      endOffsetMs: 1100,
      status: "OK",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 412,
      outputTokens: 86,
      attributes: aiSdkLlmAttrs({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "You triage incoming support tickets. Choose one of: billing-team, engineering, customer-success. Always look up the user's account before deciding." },
          { role: "user", content: "User reports their export keeps timing out at 30s. Plan: Pro. Last login: 2h ago." },
        ],
        responseText: "I'll look up the account first to see what export limits apply.",
        inputTokens: 412,
        outputTokens: 86,
      }),
    },
    {
      id: "tool-1",
      parentId: "root",
      name: "lookup_account",
      spanType: "TOOL_CALL",
      startOffsetMs: 1150,
      endOffsetMs: 1480,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "lookup_account",
        args: { userId: "user_07h2" },
        result: { plan: "Pro", exportLimitSeconds: 30, eligibleForUpgrade: true, mrr: 49 },
      }),
    },
    {
      id: "llm-2",
      parentId: "root",
      name: "ai.generateText",
      spanType: "LLM_GENERATION",
      startOffsetMs: 2320,
      endOffsetMs: 5150,
      status: "OK",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 704,
      outputTokens: 168,
      attributes: aiSdkLlmAttrs({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "You triage incoming support tickets. Choose one of: billing-team, engineering, customer-success. Always look up the user's account before deciding." },
          { role: "user", content: "User reports their export keeps timing out at 30s. Plan: Pro. Last login: 2h ago." },
          { role: "assistant", content: "I'll look up the account first to see what export limits apply." },
          { role: "tool", content: JSON.stringify({ plan: "Pro", exportLimitSeconds: 30, eligibleForUpgrade: true, mrr: 49 }) },
          { role: "tool", content: JSON.stringify({ exportKind: "csv", observedTimeoutSeconds: 30, planLimitSeconds: 30 }) },
          { role: "tool", content: JSON.stringify({ ticketId: "sup-1842", queue: "billing-team", priority: "normal" }) },
        ],
        responseText: "Routing to billing-team. This looks like the expected Pro export limit rather than an engineering bug: the account is capped at 30s, the failed export timed out exactly there, and the user is eligible for Team. I opened sup-1842 with the account context and suggested the upgrade path.",
        inputTokens: 704,
        outputTokens: 168,
      }),
    },
    {
      id: "tool-2",
      parentId: "root",
      name: "check_export_limits",
      spanType: "TOOL_CALL",
      startOffsetMs: 1510,
      endOffsetMs: 1840,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "check_export_limits",
        args: { accountId: "acct_pro_07h2", exportKind: "csv" },
        result: { exportKind: "csv", observedTimeoutSeconds: 30, planLimitSeconds: 30, exceeded: true },
      }),
    },
    {
      id: "tool-3",
      parentId: "root",
      name: "create_triage_ticket",
      spanType: "TOOL_CALL",
      startOffsetMs: 1880,
      endOffsetMs: 2280,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "create_triage_ticket",
        args: { queue: "billing-team", userId: "user_07h2", reason: "export_limit_upgrade" },
        result: { ticketId: "sup-1842", queue: "billing-team", priority: "normal" },
      }),
    },
  ],
  liveEvents: [
    ...reasoningDeltaStream("llm-1", "The ticket mentions a 30s timeout. Before routing this, verify whether that matches an account limit or an infrastructure failure.", 70, 360),
    ...textDeltaStream("llm-1", "I'll look up the account first to see what export limits apply.", 400, 1080),
    toolStartEvent("tool-1", "lookup_account", { userId: "user_07h2" }, 1160),
    toolResultEvent("tool-1", '{"plan":"Pro","exportLimitSeconds":30}', 1470),
    toolStartEvent("tool-2", "check_export_limits", { accountId: "acct_pro_07h2", exportKind: "csv" }, 1520),
    toolResultEvent("tool-2", '{"observedTimeoutSeconds":30,"planLimitSeconds":30}', 1830),
    toolStartEvent("tool-3", "create_triage_ticket", { queue: "billing-team", userId: "user_07h2" }, 1890),
    toolResultEvent("tool-3", '{"ticketId":"sup-1842","queue":"billing-team"}', 2270),
    ...reasoningDeltaStream("llm-2", "The observed timeout exactly matches the plan cap. This should not page engineering; billing can resolve it with upgrade context.", 2350, 2900),
    ...textDeltaStream(
      "llm-2",
      "Routing to billing-team. This looks like the expected Pro export limit rather than an engineering bug: the account is capped at 30s, the failed export timed out exactly there, and the user is eligible for Team.",
      3000,
      5120,
    ),
  ],
};

const CODE_REVIEW_DIFF = `diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
@@
 export function authMiddleware(req, res, next) {
   if (isStateChanging(req)) {
-    csrf.verify(req);
+    if (req.path !== "/logout") csrf.verify(req);
   }
   next();
 }

diff --git a/src/auth/session.ts b/src/auth/session.ts
@@
 export function refresh(session) {
   const token = sign({ sub: session.userId });
-  return { ...session, token, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 };
+  return { ...session, token };
 }`;

const CODE_REVIEW: DemoFixture = {
  slug: "review",
  name: "Code review agent",
  eventName: "code_review_agent",
  userId: "user_42dx",
  convoId: "convo_pr_842",
  spans: [
    {
      id: "root",
      name: "code_review_agent",
      spanType: "AGENT_ROOT",
      startOffsetMs: 0,
      endOffsetMs: 6200,
      status: "OK",
      inputPayload: "Review PR #842: refactor auth middleware. 6 files changed, +124/-87.",
      outputPayload: "Found 2 blockers: missing CSRF check on /logout (line 47), session expiry not reset on token refresh (line 112). 1 nit: extract magic number 3600 to SESSION_TTL_SECONDS.",
    },
    {
      id: "llm-1",
      parentId: "root",
      name: "ai.generateText",
      spanType: "LLM_GENERATION",
      startOffsetMs: 40,
      endOffsetMs: 1380,
      status: "OK",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 1840,
      outputTokens: 142,
      attributes: aiSdkLlmAttrs({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "You are a senior code reviewer. For each PR: (1) understand the change, (2) run the test suite, (3) flag security & correctness issues, (4) suggest concrete fixes." },
          { role: "user", content: "Review PR #842: refactor auth middleware. 6 files changed, +124/-87." },
        ],
        responseText: "I'll fetch the diff, run the focused auth tests, then review the changed paths for security and correctness issues.",
        inputTokens: 1840,
        outputTokens: 142,
      }),
    },
    {
      id: "tool-0",
      parentId: "root",
      name: "get_diff",
      spanType: "TOOL_CALL",
      startOffsetMs: 1220,
      endOffsetMs: 1560,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "get_diff",
        args: { pr: 842 },
        result: CODE_REVIEW_DIFF,
      }),
    },
    {
      id: "tool-1",
      parentId: "root",
      name: "run_tests",
      spanType: "TOOL_CALL",
      startOffsetMs: 1600,
      endOffsetMs: 2320,
      status: "ERROR",
      attributes: aiSdkToolAttrs({
        name: "run_tests",
        args: { suite: "auth", changed_files: ["src/auth/middleware.ts", "src/auth/session.ts"] },
        result: "FAIL auth/middleware.test.ts > middleware > rejects expired tokens\nExpected status 401, got 200.\n  at session.refresh() did not reset expiry on token refresh.\n2 passed, 1 failed.",
        isError: true,
      }),
    },
    {
      id: "llm-2",
      parentId: "root",
      name: "ai.generateText",
      spanType: "LLM_GENERATION",
      startOffsetMs: 3980,
      endOffsetMs: 6180,
      status: "OK",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 3096,
      outputTokens: 286,
      attributes: aiSdkLlmAttrs({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "You are a senior code reviewer. For each PR: (1) understand the change, (2) run the test suite, (3) flag security & correctness issues, (4) suggest concrete fixes." },
          { role: "user", content: "Review PR #842: refactor auth middleware." },
          { role: "assistant", content: "I'll fetch the diff, run the focused auth tests, then review the changed paths for security and correctness issues." },
          { role: "tool", content: CODE_REVIEW_DIFF },
          { role: "tool", content: "FAIL auth/middleware.test.ts: expected 401, got 200. session.refresh() did not reset expiry." },
          { role: "tool", content: "src/auth/session.ts lines 96-122 show refresh() returning a new token without updating expiresAt." },
          { role: "tool", content: "src/auth/middleware.ts line 47 exempts /logout from csrf.verify(req)." },
        ],
        responseText: "Found 2 blockers in PR #842:\n\n1. **Session expiry not reset on token refresh** (src/auth/session.ts:112). The existing test catches this — it's failing right now. `refresh()` returns a new token but leaves the old `expiresAt`. Fix: set `expiresAt = now + SESSION_TTL` inside refresh().\n\n2. **Missing CSRF check on /logout** (src/auth/middleware.ts:47). The middleware exempts /logout from the CSRF check, which means an attacker can force-logout any logged-in user via a cross-site form post. Remove the exemption.\n\nNit: extract the magic 3600 in session.ts:14 to a named constant `SESSION_TTL_SECONDS`.",
        inputTokens: 3096,
        outputTokens: 286,
      }),
    },
    {
      id: "tool-2",
      parentId: "root",
      name: "read_file",
      spanType: "TOOL_CALL",
      startOffsetMs: 2380,
      endOffsetMs: 2920,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "read_file",
        args: { path: "src/auth/session.ts", range: "96-122" },
        result: "function refresh(session) {\n  const token = sign({ sub: session.userId });\n  return { ...session, token };\n}\n// expiresAt remains unchanged",
      }),
    },
    {
      id: "tool-3",
      parentId: "root",
      name: "search_repo",
      spanType: "TOOL_CALL",
      startOffsetMs: 2980,
      endOffsetMs: 3440,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "search_repo",
        args: { pattern: "csrf.*logout", path: "src/auth" },
        result: [{ file: "src/auth/middleware.ts", line: 47, text: "if (req.path !== '/logout') csrf.verify(req)" }],
      }),
    },
    {
      id: "tool-4",
      parentId: "root",
      name: "read_file",
      spanType: "TOOL_CALL",
      startOffsetMs: 3500,
      endOffsetMs: 3900,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "read_file",
        args: { path: "src/auth/middleware.ts", range: "40-52" },
        result: "if (isStateChanging(req)) {\n  if (req.path !== '/logout') csrf.verify(req);\n}\nnext();",
      }),
    },
  ],
  liveEvents: [
    ...reasoningDeltaStream("llm-1", "Start by running the focused auth suite. A failing behavior test is stronger evidence than only reading the diff.", 60, 450),
    ...textDeltaStream("llm-1", "I'll fetch the diff, run the focused auth tests, then review the changed paths for security and correctness issues.", 500, 1180),
    toolStartEvent("tool-0", "get_diff", { pr: 842 }, 1230),
    toolResultEvent("tool-0", "2 files changed", 1550),
    toolStartEvent("tool-1", "run_tests", { suite: "auth", changed_files: ["src/auth/middleware.ts", "src/auth/session.ts"] }, 1610),
    toolResultEvent("tool-1", "FAIL: 1 test failed", 2310),
    ...reasoningDeltaStream("llm-2", "The test failure points at session refresh, but security changes often hide in middleware branches. Inspect both touched files before writing findings.", 2325, 2380),
    toolStartEvent("tool-2", "read_file", { path: "src/auth/session.ts", range: "96-122" }, 2390),
    toolResultEvent("tool-2", "refresh() does not update expiresAt", 2910),
    toolStartEvent("tool-3", "search_repo", { pattern: "csrf.*logout", path: "src/auth" }, 2990),
    toolResultEvent("tool-3", "1 match in middleware.ts", 3430),
    toolStartEvent("tool-4", "read_file", { path: "src/auth/middleware.ts", range: "40-52" }, 3510),
    toolResultEvent("tool-4", "logout skips csrf.verify(req)", 3890),
    ...reasoningDeltaStream("llm-2", "There are two separate blockers: a correctness regression caught by tests and a CSRF exemption that can be exploited cross-site.", 4000, 4500),
    ...textDeltaStream(
      "llm-2",
      "Found 2 blockers in PR #842. The session expiry bug is caught by the existing test (currently failing). The CSRF exemption on /logout is exploitable via cross-site form post.",
      4600,
      6160,
    ),
  ],
};

const RESEARCH_AGENT: DemoFixture = {
  slug: "research",
  name: "Research assistant",
  eventName: "research_agent",
  userId: "user_9xkv",
  convoId: "convo_research_18",
  spans: [
    {
      id: "root",
      name: "research_agent",
      spanType: "AGENT_ROOT",
      startOffsetMs: 0,
      endOffsetMs: 7600,
      status: "OK",
      inputPayload: "What's the current state of Apple's M5 chip rumors? I want sources from the last 30 days.",
      outputPayload: "Three credible sources from Apr–May 2026 point to M5 launching at WWDC 2026 (June). TSMC's 2nm N2 process, ~15% perf bump over M4, focused on on-device LLM workloads (Neural Engine doubled). Sources: Bloomberg (May 3), MacRumors (Apr 28), and DigiTimes (May 1).",
    },
    {
      id: "llm-1",
      parentId: "root",
      name: "ai.generateText",
      spanType: "LLM_GENERATION",
      startOffsetMs: 30,
      endOffsetMs: 980,
      status: "OK",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 320,
      outputTokens: 64,
      attributes: aiSdkLlmAttrs({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "You research questions using the available tools. Always cite sources and prefer the last 30 days." },
          { role: "user", content: "What's the current state of Apple's M5 chip rumors? I want sources from the last 30 days." },
        ],
        responseText: "I'll search for recent Apple M5 chip coverage, filtered to the last 30 days.",
        inputTokens: 320,
        outputTokens: 64,
      }),
    },
    {
      id: "tool-1",
      parentId: "root",
      name: "web_search",
      spanType: "TOOL_CALL",
      startOffsetMs: 1020,
      endOffsetMs: 1820,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "web_search",
        args: { query: "Apple M5 chip rumors", recency_days: 30 },
        result: {
          results: [
            { title: "Apple's M5 chip will lean hard into on-device AI, Bloomberg reports", url: "bloomberg.com/...", date: "2026-05-03", snippet: "TSMC 2nm N2..." },
            { title: "M5 specs leak: doubled Neural Engine, modest CPU gains", url: "macrumors.com/...", date: "2026-04-28", snippet: "..." },
            { title: "DigiTimes: M5 production ramp on track for June launch", url: "digitimes.com/...", date: "2026-05-01", snippet: "..." },
          ],
        },
      }),
    },
    {
      id: "llm-2",
      parentId: "root",
      name: "ai.generateText",
      spanType: "LLM_GENERATION",
      startOffsetMs: 1860,
      endOffsetMs: 2680,
      status: "OK",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 612,
      outputTokens: 78,
      attributes: aiSdkLlmAttrs({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "(continued, with search results)" }],
        responseText: "The Bloomberg piece looks most authoritative. Let me fetch the full article for the specifics on perf claims.",
        inputTokens: 612,
        outputTokens: 78,
      }),
    },
    {
      id: "tool-2",
      parentId: "root",
      name: "fetch_url",
      spanType: "TOOL_CALL",
      startOffsetMs: 2720,
      endOffsetMs: 3540,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "fetch_url",
        args: { url: "bloomberg.com/news/apple-m5-on-device-ai" },
        result: { title: "Apple's M5 chip will lean hard into on-device AI", excerpt: "Apple's next-generation M5 chip, expected to debut at WWDC in June, will focus heavily on on-device AI workloads, according to people familiar with the matter. The chip uses TSMC's 2nm N2 process and roughly doubles the Neural Engine performance of the M4 while delivering modest 15% CPU gains.", word_count: 842 },
      }),
    },
    {
      id: "llm-3",
      parentId: "root",
      name: "ai.generateText",
      spanType: "LLM_GENERATION",
      startOffsetMs: 4700,
      endOffsetMs: 7580,
      status: "OK",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 1812,
      outputTokens: 246,
      attributes: aiSdkLlmAttrs({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "(continued, with Bloomberg and MacRumors fetched, source dates checked)" }],
        responseText: "Three credible sources from Apr–May 2026 converge on the M5 story:\n\n• **Bloomberg (May 3):** M5 debuts at WWDC 2026 (June). TSMC 2nm N2 process. Neural Engine roughly doubled to push on-device LLM workloads. CPU gains modest (~15% over M4).\n• **MacRumors (Apr 28):** Independent supply-chain leak corroborates doubled Neural Engine and modest CPU bump.\n• **DigiTimes (May 1):** Production ramp on schedule for June launch.\n\nConvergent signal across three independent sources, including a Bloomberg report with a strong track record on Apple silicon rumors. High confidence on the WWDC June timing and on-device-AI focus; medium confidence on exact perf numbers (these are still pre-announcement leaks).",
        inputTokens: 1812,
        outputTokens: 246,
      }),
    },
    {
      id: "tool-3",
      parentId: "root",
      name: "fetch_url",
      spanType: "TOOL_CALL",
      startOffsetMs: 3580,
      endOffsetMs: 4200,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "fetch_url",
        args: { url: "macrumors.com/2026/04/28/m5-neural-engine-leak" },
        result: { title: "M5 specs leak: doubled Neural Engine, modest CPU gains", date: "2026-04-28", excerpt: "Supply-chain sources point to a doubled Neural Engine and a modest CPU bump over M4.", word_count: 516 },
      }),
    },
    {
      id: "tool-4",
      parentId: "root",
      name: "cross_check_source_dates",
      spanType: "TOOL_CALL",
      startOffsetMs: 4240,
      endOffsetMs: 4620,
      status: "OK",
      attributes: aiSdkToolAttrs({
        name: "cross_check_source_dates",
        args: { urls: ["bloomberg.com/...", "macrumors.com/...", "digitimes.com/..."], maxAgeDays: 30 },
        result: { allWithinWindow: true, newest: "2026-05-03", oldest: "2026-04-28", independentSources: 3 },
      }),
    },
  ],
  liveEvents: [
    ...reasoningDeltaStream("llm-1", "The user asked for current rumors, so prioritize recent sources and then cross-check whether the claims are independent.", 50, 360),
    ...textDeltaStream("llm-1", "I'll search for recent Apple M5 chip coverage, filtered to the last 30 days.", 420, 960),
    toolStartEvent("tool-1", "web_search", { query: "Apple M5 chip rumors", recency_days: 30 }, 1030),
    toolResultEvent("tool-1", "3 results", 1810),
    ...reasoningDeltaStream("llm-2", "Bloomberg is the strongest primary signal, but one source is not enough for a rumor summary. Fetch it, then verify with another outlet.", 1850, 2200),
    ...textDeltaStream("llm-2", "The Bloomberg piece looks most authoritative. Let me fetch the full article for the specifics on perf claims.", 2250, 2660),
    toolStartEvent("tool-2", "fetch_url", { url: "bloomberg.com/news/apple-m5-on-device-ai" }, 2730),
    toolResultEvent("tool-2", "842 words", 3530),
    toolStartEvent("tool-3", "fetch_url", { url: "macrumors.com/2026/04/28/m5-neural-engine-leak" }, 3590),
    toolResultEvent("tool-3", "516 words", 4190),
    toolStartEvent("tool-4", "cross_check_source_dates", { maxAgeDays: 30, sourceCount: 3 }, 4250),
    toolResultEvent("tool-4", "3 independent sources in window", 4610),
    ...reasoningDeltaStream("llm-3", "All cited items are inside the requested window. Separate high-confidence convergence from exact performance numbers, which are still pre-announcement leaks.", 4720, 5550),
    ...textDeltaStream(
      "llm-3",
      "Three credible sources from Apr–May 2026 converge on the M5 story: Bloomberg (May 3) — M5 at WWDC June, TSMC 2nm, doubled Neural Engine. MacRumors (Apr 28) corroborates. DigiTimes (May 1) confirms production ramp on schedule.",
      5650,
      7560,
    ),
  ],
};

const FIXTURES: DemoFixture[] = [TRIAGE_AGENT, CODE_REVIEW, RESEARCH_AGENT];
const DEMO_RUN_IDS = FIXTURES.map((fixture) => `demo_${fixture.slug}`);
const DEMO_REPLAY_STAGGER_MS = 900;
let pendingReplayTimers: Array<ReturnType<typeof setTimeout>> = [];

export function replayDefaultDemoTraces(opts: { broadcast?: BroadcastFn } = {}): { runIds: string[] } {
  clearPendingReplayTimers();
  for (const runId of DEMO_RUN_IDS) {
    deleteRun(runId);
  }
  opts.broadcast?.("spans", { runIds: DEMO_RUN_IDS, count: 0 });

  for (let i = 0; i < FIXTURES.length; i++) {
    streamFixture(FIXTURES[i], i * DEMO_REPLAY_STAGGER_MS, opts.broadcast);
  }

  return { runIds: DEMO_RUN_IDS };
}

function clearPendingReplayTimers(): void {
  for (const timer of pendingReplayTimers) clearTimeout(timer);
  pendingReplayTimers = [];
}

interface AiSdkLlmInput {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  responseText: string;
  inputTokens: number;
  outputTokens: number;
}

function aiSdkLlmAttrs(input: AiSdkLlmInput): Record<string, string | number> {
  return {
    "ai.prompt.messages": JSON.stringify(input.messages),
    "ai.model.id": input.model,
    "ai.model.provider": "anthropic",
    "ai.response.text": input.responseText,
    "ai.usage.inputTokens": input.inputTokens,
    "ai.usage.outputTokens": input.outputTokens,
  };
}

interface AiSdkToolInput {
  name: string;
  args: unknown;
  result: unknown;
  isError?: boolean;
}

function aiSdkToolAttrs(input: AiSdkToolInput): Record<string, string | number> {
  const argsStr = typeof input.args === "string" ? input.args : JSON.stringify(input.args);
  const resultStr = typeof input.result === "string" ? input.result : JSON.stringify(input.result);
  const attrs: Record<string, string | number> = {
    "ai.toolCall.name": input.name,
    "ai.toolCall.args": argsStr,
    "ai.toolCall.result": resultStr,
  };
  if (input.isError) attrs["otel.status.message"] = resultStr;
  return attrs;
}

// text_delta events spread evenly across [startMs, endMs], split on word
// boundaries so the typing effect doesn't feel character-by-character.
function textDeltaStream(spanId: string, text: string, startMs: number, endMs: number): DemoLiveEvent[] {
  const chunks = chunkForStreaming(text);
  const span = Math.max(1, endMs - startMs);
  const step = span / chunks.length;
  return chunks.map((chunk, i) => ({
    spanId,
    type: "text_delta" as const,
    content: chunk,
    atOffsetMs: Math.round(startMs + step * i),
  }));
}

function reasoningDeltaStream(spanId: string, text: string, startMs: number, endMs: number): DemoLiveEvent[] {
  const chunks = chunkForStreaming(text);
  const span = Math.max(1, endMs - startMs);
  const step = span / chunks.length;
  return chunks.map((chunk, i) => ({
    spanId,
    type: "reasoning_delta" as const,
    content: chunk,
    atOffsetMs: Math.round(startMs + step * i),
  }));
}

function chunkForStreaming(text: string): string[] {
  // 2–4 word chunks, preserving the trailing whitespace so re-assembly is exact.
  const out: string[] = [];
  const tokens = text.match(/\S+\s*/g) ?? [text];
  for (let i = 0; i < tokens.length; i += 3) {
    out.push(tokens.slice(i, i + 3).join(""));
  }
  return out.length ? out : [text];
}

function toolStartEvent(spanId: string, name: string, args: Record<string, unknown>, atOffsetMs: number): DemoLiveEvent {
  return { spanId, type: "tool_start", content: name, metadata: { args }, atOffsetMs };
}

function toolResultEvent(spanId: string, content: string, atOffsetMs: number): DemoLiveEvent {
  return { spanId, type: "tool_result", content, atOffsetMs };
}

function streamFixture(fixture: DemoFixture, startDelayMs: number, broadcast?: BroadcastFn): void {
  scheduleReplay(startDelayMs, () => {
    const startWall = Date.now();
    const runId = `demo_${fixture.slug}`;
    const spanIdMap = buildSpanIdMap(runId, fixture);
    const root = fixture.spans.find((span) => !span.parentId);

    upsertDemoRun(fixture, runId, startWall, startWall);
    if (root) insertDemoSpan(root, runId, spanIdMap, startWall, false);
    broadcast?.("spans", { runIds: [runId], count: root ? 1 : 0 });

    for (const span of fixture.spans) {
      if (span === root) continue;
      if (span.spanType === "LLM_GENERATION") {
        scheduleReplay(span.startOffsetMs, () => {
          upsertDemoRun(fixture, runId, startWall, startWall + span.startOffsetMs);
          insertDemoSpan(span, runId, spanIdMap, startWall, false);
          broadcast?.("spans", { runIds: [runId], count: 1 });
        });
      }

      scheduleReplay(span.endOffsetMs, () => {
        upsertDemoRun(fixture, runId, startWall, startWall + span.endOffsetMs);
        insertDemoSpan(span, runId, spanIdMap, startWall, true);
        broadcast?.("spans", { runIds: [runId], count: 1 });
      });
    }

    for (const live of fixture.liveEvents) {
      scheduleReplay(live.atOffsetMs, () => {
        const realSpanId = spanIdMap.get(live.spanId)!;
        const event = {
          traceId: runId,
          spanId: realSpanId,
          type: live.type,
          content: live.content,
          timestamp: startWall + live.atOffsetMs,
          metadata: live.metadata,
        };
        upsertLiveEvent(event);
        upsertDemoRun(fixture, runId, startWall, startWall + live.atOffsetMs);
        broadcast?.("live", {
          traceId: event.traceId,
          spanId: event.spanId,
          type: event.type,
          content: event.content,
          timestamp: event.timestamp,
          metadata: event.metadata,
        });
      });
    }

    if (root) {
      scheduleReplay(root.endOffsetMs, () => {
        upsertDemoRun(fixture, runId, startWall, startWall + root.endOffsetMs);
        insertDemoSpan(root, runId, spanIdMap, startWall, true);
        broadcast?.("spans", { runIds: [runId], count: fixture.spans.length });
      });
    }
  });
}

function scheduleReplay(delayMs: number, fn: () => void): void {
  const timer = setTimeout(() => {
    pendingReplayTimers = pendingReplayTimers.filter((candidate) => candidate !== timer);
    fn();
  }, delayMs);
  pendingReplayTimers.push(timer);
}

function buildSpanIdMap(runId: string, fixture: DemoFixture): Map<string, string> {
  const spanIdMap = new Map<string, string>();
  for (const span of fixture.spans) spanIdMap.set(span.id, `${runId}_${span.id}`);
  return spanIdMap;
}

function upsertDemoRun(fixture: DemoFixture, runId: string, startWall: number, lastUpdatedAt: number): void {
  upsertRun({
    id: runId,
    name: fixture.name,
    event_name: fixture.eventName,
    user_id: fixture.userId,
    convo_id: fixture.convoId,
    started_at: startWall,
    last_updated_at: lastUpdatedAt,
    metadata: JSON.stringify({ demo: true, default: true }),
  });
}

function insertDemoSpan(
  span: DemoSpan,
  runId: string,
  spanIdMap: Map<string, string>,
  startWall: number,
  complete: boolean,
): void {
  const realSpanId = spanIdMap.get(span.id)!;
  const realParentId = span.parentId ? spanIdMap.get(span.parentId) : undefined;
  const startMs = startWall + span.startOffsetMs;
  const endMs = complete ? startWall + span.endOffsetMs : startMs;
  const attributes = span.attributes
    ? JSON.stringify(complete ? span.attributes : stripCompletionAttrs(span.attributes))
    : undefined;

  insertSpan({
    id: realSpanId,
    run_id: runId,
    parent_span_id: realParentId,
    name: span.name,
    span_type: span.spanType,
    status: complete ? span.status ?? "OK" : "UNSET",
    input_payload: span.inputPayload ?? span.attributes?.["ai.prompt.messages"]?.toString() ?? span.attributes?.["ai.toolCall.args"]?.toString(),
    output_payload: complete
      ? span.outputPayload ?? span.attributes?.["ai.response.text"]?.toString() ?? span.attributes?.["ai.toolCall.result"]?.toString()
      : undefined,
    start_time_ms: startMs,
    end_time_ms: endMs,
    duration_ms: endMs - startMs,
    model: span.model,
    provider: span.provider,
    input_tokens: complete ? span.inputTokens : undefined,
    output_tokens: complete ? span.outputTokens : undefined,
    attributes,
  });
}

function stripCompletionAttrs(attrs: Record<string, string | number>): Record<string, string | number> {
  const next = { ...attrs };
  delete next["ai.response.text"];
  delete next["ai.response.object"];
  delete next["gen_ai.completion.0.content"];
  delete next["ai.toolCall.result"];
  delete next["otel.status.message"];
  delete next["ai.usage.outputTokens"];
  return next;
}
