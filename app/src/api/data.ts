import { apiJson } from "./request";

export interface DataSummary {
  version: string;
  dbPath: string;
  dbBytes: number;
  runs: number;
  steps: number;
  savedRuns: number;
}

export function getDataSummary(): Promise<DataSummary> {
  return apiJson<DataSummary>("/api/data", { cache: "no-store" });
}

export const DATABASE_BACKUP_URL = "/api/data/backup";
