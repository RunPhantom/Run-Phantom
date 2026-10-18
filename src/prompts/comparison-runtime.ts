import type { PromptOwner } from "./registry";
import type { Database } from "bun:sqlite";
import { acquireComparisonOwner } from "./comparison-owner";
import { ComparisonCoordinator } from "./comparison";
import { ComparisonStore } from "./comparison-store";
import { COMPARISON_LIMITS, ComparisonError, type ComparisonProvider } from "./comparison-protocol";
import { comparisonBudgetMicrousd } from "./spend-ledger";
import { createComparisonProviderClient } from "./providers";

export interface ComparisonRuntimeOptions {
  readonly budgets?: Readonly<Record<ComparisonProvider, number>>;
  readonly client?: ReturnType<typeof createComparisonProviderClient>;
}
/** Trusted migration/startup/project creation only. No request creates controls or installs tables. */
export function initializeComparisonScope(owner: PromptOwner): void {
  const scope = `${owner.scope.kind}:${owner.scope.id}`;
  owner.database.transaction(() => {
    const parent = owner.database.query("SELECT e.active FROM evaluation_evidence_scopes e JOIN prompt_scope_controls p USING(scope_key) WHERE e.scope_key=?").get(scope) as { active: number } | null;
    if (parent?.active !== 1) throw new ComparisonError("unavailable");
    const controls = owner.database.query("SELECT count(*) n FROM comparison_scope_controls").get() as { n: number };
    const existing = owner.database.query("SELECT generation FROM comparison_scope_controls WHERE scope_key=?").get(scope);
    if (!existing && controls.n >= COMPARISON_LIMITS.controlsGlobal) throw new ComparisonError("capacity");
    owner.database.query("INSERT INTO comparison_scope_controls(scope_key,generation) VALUES(?,1) ON CONFLICT(scope_key) DO NOTHING").run(scope);
    if (owner.database.query("PRAGMA foreign_key_check").all().length) throw new ComparisonError("integrity");
  }).immediate();
}
/** One native lease and coordinator per actual owner database. Budgets default to zero. */
export async function createComparisonRuntime(database: Database, options: ComparisonRuntimeOptions = {}) {
  const live = await acquireComparisonOwner(database.filename);
  try {
    const client = options.client ?? createComparisonProviderClient();
    const budgets = options.budgets ?? { openai: comparisonBudgetMicrousd(process.env.RUNPHANTOM_COMPARISON_OPENAI_BUDGET_USD),
      anthropic: comparisonBudgetMicrousd(process.env.RUNPHANTOM_COMPARISON_ANTHROPIC_BUDGET_USD) };
    const availability = { openai: client.available("openai"), anthropic: client.available("anthropic") };
    // One recovery occurs only after real kernel acquisition, before admitting any HTTP request.
    ComparisonStore.recoverPendingDatabase(database, live);
    const coordinator = new ComparisonCoordinator(live, client);
    return Object.freeze({
      coordinator,
      scope(scopedOwner: PromptOwner): ComparisonStore { return new ComparisonStore(scopedOwner, live, { budgets, availability }); },
      close(): Promise<void> { return coordinator.close(); },
      drained(): Promise<void> { return live.drained(); },
    });
  } catch (error) { await live.close(); throw error; }
}
export type ComparisonRuntime = Awaited<ReturnType<typeof createComparisonRuntime>>;
