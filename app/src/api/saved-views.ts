import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson, jsonInit } from "./request";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import type { SavedView, SavedViewInput, SavedViewWithCount } from "../../../src/saved-views-protocol";

export type { SavedView, SavedViewInput, SavedViewWithCount } from "../../../src/saved-views-protocol";

export const SAVED_VIEWS_KEY = ["saved-views"] as const;
const COUNT_REFRESH_MS = 5000;

export const savedViewsApi = {
  list: (signal?: AbortSignal) => apiJson<{ views: SavedViewWithCount[] }>("/api/saved-views", { signal, cache: "no-store" }).then(body => body.views),
  create: (input: SavedViewInput) => apiJson<{ view: SavedView }>("/api/saved-views", jsonInit("POST", input)).then(body => body.view),
  update: (id: string, update: Partial<SavedViewInput>) => apiJson<{ view: SavedView }>(`/api/saved-views/${encodeURIComponent(id)}`, jsonInit("PATCH", update)).then(body => body.view),
  remove: (id: string) => apiJson<{ ok: true }>(`/api/saved-views/${encodeURIComponent(id)}`, jsonInit("DELETE")),
};

/**
 * Saved views with live counts. Edits from any tab arrive as a "saved_views" event; counts follow new and removed
 * runs at most once per 5 s, the same cadence as the Runs nav count.
 */
export function useSavedViews() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: SAVED_VIEWS_KEY, queryFn: ({ signal }) => savedViewsApi.list(signal), retry: false });
  const timer = useRef<number | null>(null);
  const scheduleCounts = () => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: SAVED_VIEWS_KEY, exact: true });
    }, COUNT_REFRESH_MS);
  };
  useRunPhantomEvent("saved_views", () => { void queryClient.invalidateQueries({ queryKey: SAVED_VIEWS_KEY, exact: true }); });
  useRunPhantomEvent("spans", () => { if (query.data?.length) scheduleCounts(); });
  useRunPhantomEvent("clear", scheduleCounts);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return query;
}
