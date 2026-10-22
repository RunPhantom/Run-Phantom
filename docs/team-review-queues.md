# Project review queues

Open **Review queues** in a Team project to retain captured responses, edit
structured targets and promote approved examples into a curated project dataset.
Queues and datasets are shared with current members of that project.

Viewers can read frozen sources and saved revisions. Editors and admins can
create queues, intake project traces, edit targets, approve or reopen reviews,
create datasets and promote approved examples. Admins can delete queues, items
and datasets. The server checks the current session and project role on every
operation, including the final transaction.

A queue fixes its target fields when it is created. Text, number, boolean and
choice fields compile into dataset expectations. Numeric zero and boolean false
remain typed values. Intake retains a safe snapshot of the selected response;
later captures do not replace that snapshot. Retrying intake returns the original
item, including its existing approval.

Edits save after a short delay. Switching between items keeps pending drafts.
Approval waits for pending acknowledgments and sends the newest complete target.
A stale revision produces an explicit conflict: retry the original request after
a lost acknowledgment, or reapply your draft to the current revision. Approval
records the project account and its role at that time. It is curator input, not a
machine verdict or a claim about a separately verified person's identity.

Promotion accepts up to 50 currently approved items and the destination's
expected revision. One transaction creates the next frozen dataset revision,
marks the items promoted, and records a receipt. An exact retry with the same
project, queue, request and idempotency key returns the first receipt even after
the dataset head or source trace advances. A different request with that key is
refused. Existing curated case identities cannot be replaced by re-intake.

Receipt links select the saved dataset revision explicitly. Refreshing that link
keeps the same revision; an invalid or deleted revision is visibly unavailable.
Download exports portable case definitions without project account witnesses,
review notes or source trace identifiers.

Each project retains at most 100 queues, 10,000 items per queue, 50,000 queue items
in total and 10,000 promotion receipts. Review content has a 256 MiB logical byte
limit within the project's 512 MiB storage quota. Project datasets retain up to
50 datasets, 20 revisions per dataset and 50 cases per revision. Requests are
bounded to 64 KiB. The page loads at most two metadata pages of 50 items, five full
source items and 16 pending drafts; pending drafts retain only editable targets
and save metadata outside the source window. Reaching a retention limit refuses
new storage and preserves existing content.

Deleting a source trace removes its queued items. Promoted dataset revisions
keep their frozen examples. Deleting a queue removes its sources, drafts and
receipts while keeping dataset revisions. Deleting a dataset removes all its
frozen revisions, and its receipts can no longer reopen those deleted revisions.
Deleting the project removes all of its review storage.

The Team database upgrades atomically to schema version 4 using its existing
strict catalog validation. Existing Team evidence and prompt storage remains in
the same database and preserves its prior schema objects and rows.
