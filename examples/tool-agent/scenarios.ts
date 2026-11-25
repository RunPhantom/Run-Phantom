import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadWorkspaceEnv } from "../loadEnv";
import { describeTurn, runTurn, type TurnResult } from "./agent";
import { DEFAULT_MODELS, PROVIDERS, type Message, type Provider } from "./providers";

export interface Scenario {
  id: string;
  title: string;
  subagent?: boolean;
  turns: string[];
  /** What a well-behaved model run should end as in Run Phantom. Models can still deviate; the runner reports it. */
  expected: "complete" | "completed_with_errors" | "failed";
}

export const SCENARIOS: Scenario[] = [
  {
    id: "refund-damaged",
    title: "Refund a damaged order",
    turns: ["Hi, order A1001 arrived with a cracked headphone case. I'd like my money back please."],
    expected: "complete",
  },
  {
    id: "inventory-outage",
    title: "Exchange while inventory is down",
    turns: ["Can I exchange the lamp in order A1002 for the KB-200 keyboard? Please check the keyboard is in stock first."],
    expected: "completed_with_errors",
  },
  {
    id: "ledger-conflict",
    title: "Refund stopped by a ledger conflict",
    turns: ["My speakers from order A1005 were lost by the courier. Please refund me."],
    expected: "failed",
  },
  {
    id: "warranty-subagent",
    title: "Warranty question via researcher",
    subagent: true,
    turns: ["The headphones from order A1004 stopped charging. What can you do for me?"],
    expected: "complete",
  },
  {
    id: "follow-up",
    title: "Two-turn order follow-up",
    turns: [
      "Where is my order A1002?",
      "Thanks. If it turns out I don't like it, can I return it once it arrives, and how long would I have?",
    ],
    expected: "complete",
  },
];

export interface ScenarioRun {
  scenario: Scenario;
  provider: Provider;
  model: string;
  conversationId: string;
  turns: TurnResult[];
}

/** The status Run Phantom derives for a finished run of this shape. */
export function observedOutcome(turn: TurnResult): Scenario["expected"] {
  if (!turn.ok) return "failed";
  return turn.toolCalls.some((call) => !call.ok) ? "completed_with_errors" : "complete";
}

export async function runScenario(scenario: Scenario, provider: Provider, model = DEFAULT_MODELS[provider]): Promise<ScenarioRun> {
  const conversationId = `conv_${scenario.id}_${provider}_${randomUUID().slice(0, 8)}`;
  let history: Message[] = [];
  const turns: TurnResult[] = [];
  for (const [index, text] of scenario.turns.entries()) {
    const eventName = scenario.turns.length > 1 ? `${scenario.title} (turn ${index + 1})` : scenario.title;
    const result = await runTurn(text, { provider, model, subagent: scenario.subagent, conversationId, eventName, history });
    turns.push(result);
    history = result.history;
    if (!result.ok) break;
  }
  return { scenario, provider, model, conversationId, turns };
}

function parseList<T extends string>(raw: string | undefined, allowed: readonly T[], flag: string): T[] {
  if (!raw) return [...allowed];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = values.filter((value) => !allowed.includes(value as T));
  if (unknown.length) throw new Error(`${flag} accepts ${allowed.join(", ")}; got ${unknown.join(", ")}.`);
  return values as T[];
}

async function main(): Promise<number> {
  loadWorkspaceEnv(import.meta.url);
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      scenario: { type: "string" },
      "openai-model": { type: "string" },
      "anthropic-model": { type: "string" },
      "gemini-model": { type: "string" },
      list: { type: "boolean", default: false },
    },
  });
  if (values.list) {
    for (const scenario of SCENARIOS) console.log(`${scenario.id.padEnd(18)} ${scenario.title} (expected: ${scenario.expected})`);
    return 0;
  }
  const providers = parseList(values.provider, PROVIDERS, "--provider");
  const scenarios = parseList(values.scenario, SCENARIOS.map((scenario) => scenario.id), "--scenario")
    .map((id) => SCENARIOS.find((scenario) => scenario.id === id)!);
  const models: Record<Provider, string> = {
    openai: values["openai-model"] || DEFAULT_MODELS.openai,
    anthropic: values["anthropic-model"] || DEFAULT_MODELS.anthropic,
    gemini: values["gemini-model"] || DEFAULT_MODELS.gemini,
  };

  const summary: string[] = [];
  let exportFailures = 0;
  for (const provider of providers) {
    for (const scenario of scenarios) {
      console.log(`\n== ${scenario.title} · ${provider} ${models[provider]}`);
      const run = await runScenario(scenario, provider, models[provider]);
      for (const [index, turn] of run.turns.entries()) {
        console.log(`you: ${scenario.turns[index]}`);
        console.log(describeTurn(turn));
        if (turn.exportError) exportFailures++;
      }
      const last = run.turns[run.turns.length - 1];
      const outcome = observedOutcome(last);
      const verdict = outcome === scenario.expected ? "as expected" : `expected ${scenario.expected}`;
      const reason = last.ok ? "" : `  (${(last.error ?? "").slice(0, 80)})`;
      summary.push(`${provider.padEnd(9)} ${scenario.id.padEnd(18)} ${outcome.padEnd(22)} ${verdict.padEnd(32)} ${last.runUrl}${reason}`);
    }
  }
  console.log(`\n${summary.join("\n")}`);
  return exportFailures ? 1 : 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
