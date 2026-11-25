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

export async function downloadDatabaseBackup(): Promise<void> {
  const response = await fetch("/api/data/backup", { method: "POST", cache: "no-store" });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof failure?.error === "string" ? failure.error : `The backup could not be downloaded (HTTP ${response.status}).`);
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "runphantom-backup.db";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
