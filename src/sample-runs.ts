/** Runs written by "Load sample runs" (demo traces), as opposed to runs the user captured. */
export function isSampleRun(row: { id: string; metadata: string | null }): boolean {
  if (row.id.startsWith("demo_")) return true;
  if (!row.metadata) return false;
  try {
    const metadata = JSON.parse(row.metadata);
    return metadata?.demo === true && metadata?.default === true;
  } catch {
    return false;
  }
}
