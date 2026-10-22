# Local review queues

A review queue retains a safe, frozen response from an exact captured run and an optional response span. You can edit its case name, reference input, tags, structured expected values and review note. Retrying intake returns the original retained source, even when the live capture changes.

Approval records **local operator review**. It is separate from an evaluation verdict and does not identify an authenticated reviewer. Reopen an approved review before editing it. Promoted items are terminal.

Each queue has an immutable schema with up to eight text, number, boolean or choice fields. Text may map to the entire response; typed values map to an existing JSON-property equality expectation. Required fields must be supplied before approval. Number and boolean targets remain typed values.

Drafts save independently after a short debounce. An immediate approval waits for an existing save acknowledgment, then sends the newest complete draft with its acknowledged revision. Conflicts keep your local draft and block approval. Reapply explicitly to the latest revision, retry the original failed request, or confirm that the draft should be discarded. Navigation protects retained and in-flight drafts.

Select up to 50 approved items and an existing destination dataset revision. Promotion creates one actual immutable dataset revision, marks all selected items terminal and retains a retry receipt in the same local SQLite transaction. Retrying the same request returns its original receipt. A changed request, stale item revision, stale destination revision or duplicate curated case is refused. The saved revision link continues to open that exact revision after the dataset head advances.

## Retention and deletion

The UI loads up to two metadata pages of 50 items and a source window of five items. At most 16 dirty or in-flight drafts are retained outside the active source window with source-free revision and acknowledgment metadata. Saving, retrying or discarding drafts frees that budget. Finite HTTP replies may briefly coexist with the previous window while it is replaced; persistent state and pending autosave frames do not retain full source payloads outside the window.

Storage limits are 100 queues, 10,000 items per queue, 50,000 items total, 10,000 promotion receipts and 256 MiB of logical UTF-8 schema, source, draft and receipt content. A schema is at most 8 KiB, a retained source 48 KiB and a draft 32 KiB. Requests are limited to 64 KiB. Reaching a limit refuses additional retention; it does not silently evict drafts.

Deleting a source run removes its queued source items. Deleting a queue removes its retained items and receipts. Deleting a dataset revision removes receipts that refer to it. Existing immutable dataset examples keep their frozen data when the original queue or source is deleted. Portable dataset export retains explicit expectations and reference inputs and excludes queue notes and local source identities.

A queue UUID is never reused. Deleting and re-intaking the same membership allocates a fresh revision from the queue's monotonic counter, so delayed requests cannot address the new source incarnation with an old revision.

## Component verification

The isolated component suite mounts the owned router and UI against an ephemeral database through the normal migrations. The connected suite uses the actual source app, sidebar, local router, daemon access guards and HTTP API against an ephemeral database. Native controls cover migration upgrade and rollback, stale revisions, transactional promotion and restart. A copied executable needs its own two-boot verification.
