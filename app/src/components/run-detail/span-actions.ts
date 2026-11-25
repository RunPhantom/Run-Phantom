import { useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";
import type { NavigateFunction } from "react-router-dom";
import type { Span } from "../../utils/types";

export interface SpanActionContext {
  span: Span;
  /** Every span of the run (or sub-agent) the drawer belongs to. */
  spans: readonly Span[];
  runId: string;
  navigate: NavigateFunction;
}

/**
 * A button in the span drawer header. Register from any feature module; the
 * drawer renders every action whose `when` passes, sorted by `order`, then id.
 * See ~/.runphantom-launch/contracts/run-detail.md.
 */
export interface SpanAction {
  /** Unique; registering the same id again replaces the earlier entry. */
  id: string;
  /** Visible text and accessible name, e.g. "Open in Playground". */
  label: string;
  icon?: LucideIcon;
  /** Lower sorts first; default 100. */
  order?: number;
  when?: (context: SpanActionContext) => boolean;
  run: (context: SpanActionContext) => void | Promise<void>;
}

let actions: readonly SpanAction[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly SpanAction[]): void {
  actions = [...next].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  for (const listener of listeners) listener();
}

/** Returns a dispose function that removes exactly this registration. */
export function registerSpanAction(action: SpanAction): () => void {
  publish([...actions.filter(entry => entry.id !== action.id), action]);
  return () => {
    if (actions.includes(action)) publish(actions.filter(entry => entry !== action));
  };
}

export function listSpanActions(): readonly SpanAction[] {
  return actions;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSpanActions(context: SpanActionContext | null): SpanAction[] {
  const all = useSyncExternalStore(subscribe, listSpanActions, listSpanActions);
  if (!context) return [];
  return all.filter(action => {
    try { return action.when ? action.when(context) : true; } catch { return false; }
  });
}
