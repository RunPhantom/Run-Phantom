import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  type Annotation,
  type AnnotationBroadcast,
  type AnnotationKind,
  type AnnotationSource,
} from "../api/annotations";
import { useRunPhantomEvent } from "./use-runphantom-ws";

export type { Annotation, AnnotationKind, AnnotationSource };

/**
 * Loads annotations for a run and keeps them live via the `annotation` WS
 * event. `freshIds` is the set of annotation ids that arrived via WS after
 * the initial load — the caller uses this to trigger the arrival animation
 * exactly once per annotation.
 */
export function useAnnotations(runId: string | null | undefined) {
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const hydrated = useRef(false);
  const queryClient = useQueryClient();
  // Memoised: this array is a useCallback dependency below, and a fresh
  // identity every render defeats the memoisation it participates in.
  const queryKey = useMemo(() => ["annotations", runId] as const, [runId]);
  const annotationsQuery = useQuery({
    queryKey,
    queryFn: () => listAnnotations(runId!),
    enabled: !!runId,
    // placeholderData (not initialData): a run's persisted annotations must be
    // fetched on mount. initialData marks the query fresh and suppresses the
    // GET entirely, so annotations only ever appeared via the create mutation.
    placeholderData: [] as Annotation[],
  });
  if (annotationsQuery.isSuccess) hydrated.current = true;

  // Live updates
  useRunPhantomEvent("annotation", (data: AnnotationBroadcast) => {
    if (!data || data.run_id !== runId) return;
    if (data.op === "insert") {
      queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) =>
        prev.some((a) => a.id === data.annotation.id)
          ? prev
          : [...prev, data.annotation].sort((a, b) => a.created_at - b.created_at)
      );
      // Only agent annotations animate — user-authored ones appear
      // silently because the user just created them and doesn't need a CTA.
      if (hydrated.current && data.annotation.source !== "user") {
        setFreshIds((prev) => new Set(prev).add(data.annotation.id));
      }
    } else if (data.op === "delete") {
      queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) => prev.filter((a) => a.id !== data.annotation.id));
      setFreshIds((prev) => {
        if (!prev.has(data.annotation.id)) return prev;
        const next = new Set(prev);
        next.delete(data.annotation.id);
        return next;
      });
    }
  });

  const clearError = useCallback(() => setError(null), []);

  const clearFresh = useCallback((id: string) => {
    setFreshIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const createMutation = useMutation({
    mutationFn: (input: { span_id?: string | null; kind: AnnotationKind; note?: string; source?: AnnotationSource }) =>
      createAnnotation({ run_id: runId!, ...input }),
    onSuccess: (annotation) => {
      queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) =>
        prev.some(a => a.id === annotation.id) ? prev : [...prev, annotation].sort((a, b) => a.created_at - b.created_at)
      );
    },
  });

  const removeMutation = useMutation({
    mutationFn: deleteAnnotation,
    onSuccess: (_result, id) => {
      queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) => prev.filter(a => a.id !== id));
    },
  });

  const create = useCallback(async (input: { span_id?: string | null; kind: AnnotationKind; note?: string; source?: AnnotationSource }) => {
    if (!runId) return null;
    // Serialised on purpose: two quick Cmd+Enter presses used to fire two
    // requests and store the note twice.
    if (createMutation.isPending) return null;
    setError(null);
    try {
      return await createMutation.mutateAsync(input);
    } catch (err) {
      // Previously `.catch(() => null)`, so a rejected save closed the popover
      // and discarded what the user had typed with nothing said. The caller
      // keeps the composer open on null and shows this.
      setError((err as Error).message || "Could not save annotation");
      return null;
    }
  }, [createMutation, runId]);

  const remove = useCallback(async (id: string) => {
    setError(null);
    try {
      await removeMutation.mutateAsync(id);
    } catch (err) {
      // A 404 means someone else already deleted it, which is the state the
      // caller wanted — drop it locally instead of rejecting. Anything else is
      // surfaced; the bare mutateAsync here produced an unhandled rejection and
      // left the row on screen.
      const message = (err as Error).message ?? "";
      if (/\b404\b|not found/i.test(message)) {
        queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) => prev.filter(a => a.id !== id));
        return;
      }
      setError(message || "Could not delete annotation");
    }
  }, [queryClient, queryKey, removeMutation]);

  return {
    annotations: annotationsQuery.data ?? [],
    freshIds,
    clearFresh,
    create,
    remove,
    error,
    clearError,
    saving: createMutation.isPending,
  };
}
