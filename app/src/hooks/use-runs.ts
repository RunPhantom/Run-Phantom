import { useQueries, useQuery } from "@tanstack/react-query";
import {
  getRunDetail,
  listConversationRuns,
  listRuns,
  normalizeRunDetail,
  type NormalizedRunDetailData,
} from "../api/runs";

export function useRuns() {
  return useQuery({
    queryKey: ["runs"],
    queryFn: listRuns,
  });
}

export function useRunDetail(runId: string | null | undefined, initialData?: NormalizedRunDetailData) {
  return useQuery({
    queryKey: ["run-detail", runId],
    queryFn: async () => normalizeRunDetail(await getRunDetail(runId!)),
    enabled: !!runId && !initialData,
    initialData,
  });
}

export function useConversationRuns(convoId: string | null | undefined) {
  return useQuery({
    queryKey: ["conversation-runs", convoId],
    queryFn: () => listConversationRuns(convoId!),
    enabled: !!convoId,
  });
}

export function useConversationDetail(convoId: string | null | undefined) {
  const runsQuery = useConversationRuns(convoId);
  const runs = runsQuery.data ?? [];
  const detailQueries = useQueries({
    queries: runs.map((run) => ({
      queryKey: ["run-detail", run.id],
      queryFn: async () => normalizeRunDetail(await getRunDetail(run.id)),
    })),
  });

  return {
    turns: runs.map((run, index) => ({
      run,
      spans: detailQueries[index]?.data?.spans ?? [],
    })),
    runIds: runs.map(run => run.id),
    isLoading: runsQuery.isLoading || detailQueries.some(query => query.isLoading),
    isError: runsQuery.isError || detailQueries.some(query => query.isError),
  };
}
