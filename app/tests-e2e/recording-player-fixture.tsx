import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import { BrowserRecording } from "../src/components/BrowserRecording";
import type { RecordingBatch, RecordingSummary } from "../../src/verification/recording-types";

type Evidence = { summary: RecordingSummary; entries: { batch: RecordingBatch; digest: string }[] };
function PlayerFixture() {
  const id = new URLSearchParams(location.search).get("id");
  const [evidence, setEvidence] = useState<Evidence | null>(null), [cursor, setCursor] = useState<number | null>(null), [error, setError] = useState("");
  const [notifications, setNotifications] = useState(0);
  async function refresh(signal?: AbortSignal) {
    const response = await fetch(`/fixture/recordings/${id}`, { signal });
    if (!response.ok) throw new Error("Recording unavailable");
    setEvidence(await response.json() as Evidence);
  }
  useEffect(() => { const owner = new AbortController(); void refresh(owner.signal).catch(() => { if (!owner.signal.aborted) setError("Recording unavailable"); }); return () => owner.abort(); }, [id]);
  async function action(type: "stop" | "delete") {
    const response = await fetch(`/fixture/recordings/${id}/${type}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error("Action unavailable");
    if (type === "delete") setEvidence(current => current ? { summary: { ...current.summary, status: "deleted", batches: 0, events: 0, bytes: 0 }, entries: [] } : null);
    else await refresh();
  }
  return <main style={{ maxWidth: 1100, padding: 16, margin: "0 auto" }}><h1 style={{ marginBottom: 16 }}>Run Phantom</h1><BrowserRecording summary={evidence?.summary ?? null} batches={evidence?.entries.map(entry => JSON.stringify(entry.batch)) ?? []} cursorEpochMs={cursor} onCursorChange={epoch => { setCursor(epoch); setNotifications(value => value + 1); }} error={error} onStop={() => action("stop")} onDelete={() => action("delete")} onExport={async () => {
    const response = await fetch(`/fixture/recordings/${id}/export`); if (!response.ok) throw new Error("Export unavailable");
    const blob = await response.blob(), url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url; anchor.download = "runphantom-masked-recording.json"; anchor.click(); URL.revokeObjectURL(url);
  }} /><output data-cursor-notifications>{notifications}</output><button onClick={() => setCursor(value => value === null ? evidence?.summary.startedAt ?? null : value + 100)}>External cursor update</button></main>;
}
createRoot(document.getElementById("root")!).render(<PlayerFixture />);
