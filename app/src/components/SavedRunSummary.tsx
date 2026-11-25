import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { getSecretStatuses } from "../api/secrets";
import { providerSummaryContent, requestProviderSummary, savedLocalSummary, savedSummarySource, type SavedEvent } from "../api/saved-runs";
import { PROVIDER_SUMMARY } from "../../../src/summary-protocol";

const failureCopy: Record<string, string> = {
  missing_provider_key: `No ${PROVIDER_SUMMARY.providerLabel} key is saved. Add one in Settings, then try again.`,
  provider_error: `${PROVIDER_SUMMARY.providerLabel} returned an error. The local summary is unchanged.`,
  provider_unavailable: `${PROVIDER_SUMMARY.providerLabel} could not be reached. The local summary is unchanged.`,
  empty_content: "This run has no captured input or output to summarize.",
  consent_required: "The request was refused because consent was missing.",
};

/**
 * The saved run's summary. Saving writes a local summary; sending the run to a
 * provider for a better one happens only after the user confirms here.
 */
export function SavedRunSummary({ event }: { event: SavedEvent }) {
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    getSecretStatuses().then(keys => { if (live) setKeyConfigured(!!keys[PROVIDER_SUMMARY.provider]?.configured); }, () => { if (live) setKeyConfigured(false); });
    return () => { live = false; };
  }, []);
  useEffect(() => setMessage(null), [event.id]);
  const source = savedSummarySource(event);
  const content = providerSummaryContent(event);
  const localSummary = source === "provider" ? savedLocalSummary(event) : null;
  const sourceNote = source === "provider" ? `Written by ${PROVIDER_SUMMARY.providerLabel} (${PROVIDER_SUMMARY.model}) at your request.`
    : source === "local" ? "Written on this machine from the captured run. Nothing was sent to a provider."
    : event.summary ? "Saved before Run Phantom recorded where summaries come from." : null;
  const send = async () => {
    setBusy(true); setMessage(null);
    try {
      const result = await requestProviderSummary(event);
      if ("reason" in result) setMessage(failureCopy[result.reason] ?? "The summary could not be written.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The summary could not be written.");
    } finally { setBusy(false); setOpen(false); }
  };
  return (
    <section aria-label="Saved run summary" className="flex flex-shrink-0 flex-col items-stretch gap-x-6 gap-y-2 border-b sm:flex-row sm:items-start border-rp-line bg-white px-5 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="rp-meta uppercase tracking-[0.12em]">Summary</h2>
        <p className="mt-1 text-[13px] leading-5 text-rp-ink">{event.summary || "No summary yet."}</p>
        {localSummary && <p className="mt-1 text-xs leading-5 text-rp-ink-muted"><span className="font-medium text-rp-ink">Recorded steps:</span> {localSummary}</p>}
        {sourceNote && <p className="rp-field-hint mt-1">{sourceNote}</p>}
        {message && <p role="alert" className="mt-1 text-xs text-rp-danger">{message}</p>}
      </div>
      <div className="flex flex-col items-stretch gap-1 sm:items-start">
        <Button ref={triggerRef} type="button" variant="outline" size="sm" disabled={!keyConfigured || busy || !content.trim()} loading={busy} onClick={() => setOpen(true)}>
          {busy ? "Summarizing…" : `Summarize with ${PROVIDER_SUMMARY.providerLabel}…`}
        </Button>
        {keyConfigured === false && <p className="rp-field-hint max-w-[260px]">Add an {PROVIDER_SUMMARY.providerLabel} key in <Link className="text-rp-blue underline underline-offset-2" to="/settings">Settings</Link> to use this.</p>}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}
          title={`Send this run to ${PROVIDER_SUMMARY.providerLabel}?`}
          description={`Run Phantom will send the excerpt below to ${PROVIDER_SUMMARY.providerLabel} (model ${PROVIDER_SUMMARY.model}) using the ${PROVIDER_SUMMARY.providerLabel} key saved on this machine. It includes the run name, the steps recorded on this machine, signal names, and up to ${PROVIDER_SUMMARY.maxFieldChars.toLocaleString()} characters each of the input and the output, with known credential formats removed. ${PROVIDER_SUMMARY.providerLabel} bills your account for the call. Nothing is sent unless you confirm.`}>
          <pre aria-label="Content that will be sent" className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rp-line bg-rp-canvas-blue p-3 font-mono text-[11px] leading-5 text-rp-ink">{content}</pre>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
            <Button type="button" onClick={() => void send()} loading={busy}>Send to {PROVIDER_SUMMARY.providerLabel}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
