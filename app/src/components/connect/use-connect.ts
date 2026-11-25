import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { deleteRun } from "../../api/runs";
import { useRunPhantomEvent } from "../../hooks/use-runphantom-ws";
import type { Run } from "../../utils/types";
import { buildTestTrace, sendTestTrace } from "./test-span";

interface SpansEvent { runIds?: unknown }

function eventRunIds(data: unknown): string[] {
  const ids = (data as SpansEvent | null)?.runIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** The newest run that first appeared over the WebSocket while this component was mounted. */
export function useNewRunArrival(): { runId: string; at: number } | null {
  const queryClient = useQueryClient();
  const [arrival, setArrival] = useState<{ runId: string; at: number } | null>(null);
  const seen = useRef(new Set<string>());
  useRunPhantomEvent("spans", data => {
    const known = queryClient.getQueryData<Run[]>(["runs"]);
    for (const runId of eventRunIds(data)) {
      if (seen.current.has(runId) || known?.some(run => run.id === runId)) continue;
      seen.current.add(runId);
      setArrival({ runId, at: Date.now() });
      void queryClient.invalidateQueries({ queryKey: ["runs"], exact: true });
    }
  });
  return arrival;
}

export type TestSpanState =
  | { phase: "idle" }
  | { phase: "sending"; traceId: string }
  | { phase: "arrived"; traceId: string; ms: number }
  | { phase: "stored"; traceId: string }
  | { phase: "removing"; traceId: string }
  | { phase: "removed"; traceId: string }
  | { phase: "remove-failed"; traceId: string; message: string }
  | { phase: "failed"; message: string };

/** How long to wait for the live update after the service accepted the trace. */
const LIVE_WAIT_MS = 4_000;

export function useTestSpan() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<TestSpanState>({ phase: "idle" });
  const pending = useRef<{ traceId: string; startedAt: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; window.clearTimeout(timer.current); }; }, []);

  useRunPhantomEvent("spans", data => {
    const current = pending.current;
    if (!current || !eventRunIds(data).includes(current.traceId)) return;
    pending.current = null;
    window.clearTimeout(timer.current);
    setState({ phase: "arrived", traceId: current.traceId, ms: Math.max(1, Math.round(performance.now() - current.startedAt)) });
  });

  const send = useCallback(async () => {
    if (pending.current) return;
    const trace = buildTestTrace();
    pending.current = { traceId: trace.traceId, startedAt: performance.now() };
    setState({ phase: "sending", traceId: trace.traceId });
    try {
      await sendTestTrace(trace);
      void queryClient.invalidateQueries({ queryKey: ["runs"], exact: true });
      if (!mounted.current || pending.current?.traceId !== trace.traceId) return;
      timer.current = window.setTimeout(() => {
        if (pending.current?.traceId !== trace.traceId) return;
        pending.current = null;
        setState({ phase: "stored", traceId: trace.traceId });
      }, LIVE_WAIT_MS);
    } catch (error) {
      if (pending.current?.traceId === trace.traceId) pending.current = null;
      if (mounted.current) setState({ phase: "failed", message: error instanceof Error ? error.message : "The local service did not accept the test span." });
    }
  }, [queryClient]);

  const remove = useCallback(async () => {
    if (state.phase !== "arrived" && state.phase !== "stored" && state.phase !== "remove-failed") return;
    const { traceId } = state;
    setState({ phase: "removing", traceId });
    try {
      await deleteRun(traceId);
      queryClient.setQueriesData<Run[]>({ queryKey: ["runs"], exact: true }, runs => runs?.filter(run => run.id !== traceId));
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      if (mounted.current) setState({ phase: "removed", traceId });
    } catch (error) {
      if (mounted.current) setState({ phase: "remove-failed", traceId, message: error instanceof Error ? error.message : "The test run could not be removed." });
    }
  }, [state, queryClient]);

  return { state, send, remove };
}
