import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { lookupRunFacts } from "../api/runs";
import { isRunDeleting } from "../hooks/use-runs";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { createRunListSync } from "./run-list-sync";

/** Mount once, in the shell. See `createRunListSync`. */
export function useRunListSync(): void {
  const queryClient = useQueryClient();
  const [sync] = useState(() => createRunListSync(queryClient, { lookup: ids => lookupRunFacts(ids), isDeleting: isRunDeleting }));

  useRunPhantomEvent<{ runIds?: unknown } | undefined>("spans", data => sync.spans(data?.runIds));
  useRunPhantomEvent("clear", () => sync.clear());
  useEffect(() => {
    window.addEventListener("runphantom:run-removed", sync.removed);
    return () => {
      window.removeEventListener("runphantom:run-removed", sync.removed);
      sync.dispose();
    };
  }, [sync]);
}
