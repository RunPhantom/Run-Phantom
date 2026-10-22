# Model comparisons

Open **Prompts**, select a saved revision and choose **Compare models** beside
Compile. Choose one to four targets, set the output and temperature limits, and
confirm **Run comparison**. The saved revision and literal variables are frozen;
unsaved editor changes are excluded. Merely opening history, compiling or
exporting never submits a provider request.

The closed standard text roster contains GPT-5.4, GPT-4.1, Claude Opus 4.6 and
Claude Sonnet 4.6. Each target retains its own queued, running or terminal state,
reason, plain text output when available, observed usage, frozen rate reference
and accounting record. A failure, timeout or cancellation preserves every
requested row. Provider invoices and account balances are unavailable.

Spending is disabled by default. The trusted server operator can configure
`RUNPHANTOM_COMPARISON_OPENAI_BUDGET_USD` and
`RUNPHANTOM_COMPARISON_ANTHROPIC_BUDGET_USD`, each between zero and thirty USD
with at most six fractional digits. Provider credentials use the existing
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` environment configuration. An HTTP body
cannot supply credentials, a provider URL, a database or another project's role.
The ceiling accounts for all retained comparison work in that owner database,
including other Team projects; it is not a statement of provider account credit.

Admission uses frozen standard text quotes and conservative input reservations.
The per-operation admission cap is at most one USD. Known reported usage can
exceed a reservation; its measured estimate is retained and subsequent spending
by that provider is blocked. Unknown pricing keeps conservative accounting.
Neither cancellation, removal, clear nor restart refunds uncertain started work.
These figures are estimates and retained accounting, not provider invoices.

Each actual owner has two native dispatch slots shared by every comparison and
scope, at most eight queued operations, four targets per operation and a thirty
second deadline starting at admission. Compiled input is limited to sixteen KiB,
output to 1,024 tokens, provider response acquisition to sixty-four KiB, retained
target output/usage to eight KiB, and HTTP requests/responses to sixty-four KiB.
History pages contain twenty summaries and do not acquire compiled input or
provider output. An operation key binds the semantic request once; an identical
retry returns its saved receipt without another dispatch.

Team viewers can read results and export them. Editors can run or cancel;
administrators can clear comparison content. The server rechecks real membership,
the native owner and independent prompt, evidence and comparison generations
before acquiring a body, within each transaction and before sending data. Losing
edit access retires active work even when viewer read access remains. Navigating
away does not silently cancel a saved operation; explicit cancellation is separate.

**Clear comparison content** requires a focus-trapped confirmation. It removes
comparison input and output while retaining accounting and operation receipts.
Those receipts still consume lifetime capacity. Saved prompts and captured
reports remain available. Removing a prompt or destroying its evidence scope
also removes its copied comparison content without rewriting final charges.

Canonical local migration 14 follows the exact existing prefix 0–13. Team schema
5 follows the qualified Team 4 catalog. Startup takes the actual kernel lease
before recovery or admission. A competing or invalid owner refuses comparison
access; request handlers never install tables, recover work or take over on a
timer. Restart marks interrupted work honestly and does not automatically retry it.

Controlled HTTP fixtures are labelled in the UI and tests. They exercise actual
native HTTP, SQLite, current routes and default built UI with no paid calls;
they do not prove real provider authentication, invoice accuracy or Windows
qualification. Those remain separate verification stages.
