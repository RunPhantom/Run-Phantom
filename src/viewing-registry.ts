export interface ViewingEntry {
  wsId: string;
  run_id: string | null;
  selected_span_id: string | null;
  ts: number;
}

export interface ViewingRegistry {
  update(wsId: string, run_id: string | null, selected_span_id?: string | null): void;
  unregister(wsId: string): void;
  getMostRecentView(): ViewingEntry | null;
}

export function createViewingRegistry(): ViewingRegistry {
  const entries = new Map<string, ViewingEntry>();

  return {
    update(wsId, run_id, selected_span_id = null) {
      entries.set(wsId, { wsId, run_id, selected_span_id, ts: Date.now() });
    },
    unregister(wsId) {
      entries.delete(wsId);
    },
    getMostRecentView() {
      let best: ViewingEntry | null = null;
      for (const e of entries.values()) {
        if (!best || e.ts > best.ts) best = e;
      }
      return best;
    },
  };
}
