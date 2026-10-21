import { useState } from "react";
import { useBlocker, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../ui/button";
import { ReviewQueues } from "./ReviewQueues";
import { EvaluationNavigation } from "../evaluations/EvaluationNavigation";

export function ReviewQueuesRoute() {
  const [params] = useSearchParams();
  const [pending, setPending] = useState({ retained: 0, inFlight: 0 });
  const blocker = useBlocker(pending.retained > 0 || pending.inFlight > 0);
  return <>
    <EvaluationNavigation active="queues" />
    <ReviewQueues initialQueueId={params.get("queueId") ?? ""} initialItemId={params.get("itemId") ?? ""} onRetainedChange={setPending} />
    <Dialog.Root open={blocker.state === "blocked"} onOpenChange={open => { if (!open && blocker.state === "blocked") blocker.reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] p-6 shadow-lg">
          <Dialog.Title className="font-[family-name:var(--font-display)] text-xl font-semibold">Retained drafts on this page</Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-[color:var(--rp-ink-soft)]">Stay to save, retry or discard your drafts. Leaving discards local drafts; saved server edits remain. Wait for current save acknowledgments before leaving.</Dialog.Description>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="outline" className="min-h-11" onClick={() => { if (blocker.state === "blocked") blocker.reset(); }}>Stay on this page</Button>
            <Button className="min-h-11" disabled={pending.inFlight > 0} onClick={() => { if (blocker.state === "blocked") blocker.proceed(); }}>Discard local drafts and leave</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
