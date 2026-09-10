# Regression evaluations

The Evaluations workspace turns captured agent runs into repeatable quality checks. It uses the existing local Run Phantom daemon and SQLite database.

## From a trace to a regression check

1. Open an agent run and choose **Evaluate run**, or open **Evaluations** in the sidebar.
2. Inspect its captured input and selected response. If several responses could represent the result, select the relevant span explicitly.
3. Create a dataset and add a named case. Declare the expected output, JSON value, tool behavior or resource limit; review the expectation before saving.
4. Choose a captured candidate run for every case and start an experiment. A later replay can supply another candidate run after its trace finishes.
5. Inspect each result and its evidence. Compare a baseline and candidate experiment against the same dataset revision, then add a separate human review where useful.

Evaluation scores captured evidence. Starting an experiment does not automatically rerun registered agents or reproduce their environment. The recorded candidate input must match the frozen case input; missing, redacted or different inputs make the case inconclusive. This prevents unrelated tasks from appearing to prove an improvement.

Input matching and response checks operate on captured text. Prompts whose normalization would discard images, audio or files are unavailable for matching; identical text alone does not establish that two multimodal requests are the same.

## Rules and evidence

Deterministic checks support output equality and containment, valid JSON and safe JSON-path equality, required/forbidden tools, ordered tool sequences, recorded errors, and token/duration/reported-cost budgets. Tool order uses completed-call intervals; overlapping or unrecorded intervals cannot establish a strict sequence.

Every check is **pass**, **fail** or **inconclusive**, with its expected and observed values and a reason. A case fails when a declared rule fails. If no rule fails but some evidence is unavailable, the case is inconclusive. Empty cases and datasets cannot produce a successful experiment.

Unknown usage is displayed as **Unavailable**. Cache and reasoning details are not added to totals a second time. Ambiguous nested usage is withheld instead of double-counted. Duration is the wall-time window of captured completed spans. Cost budgets use instrumentation-reported USD cost, with no assumption that an unpriced call was free. These are measurements of captured spans, not a guarantee of complete instrumentation or task correctness.

## Versioning and comparison

Saving a dataset edit appends a new revision; concurrent edits use an expected-version check. Each revision retains its source links, source snapshots, rules and content hash. Exported JSON contains portable definitions and can be imported as a new dataset without executing code.

Experiments freeze the selected revision, every candidate snapshot and the evaluator versions before scoring. Completed machine scores remain unchanged. Comparisons require compatible evaluator/snapshot versions and identical dataset revisions and case membership. Every case contributes to the denominator, including inconclusive results. A missing measurement yields an unavailable delta.

Human pass/fail reviews and notes are separate, append-only decisions. They do not rewrite automatic scores. Deleting a source run or dataset preserves frozen experiment history. Clearing all local data removes evaluation history and cancels active jobs.

## Optional model grading

A rubric rule can request an OpenAI or Anthropic score using credentials configured through Run Phantom's existing Settings or environment. Starting such an experiment requires an explicit opt-in to send the selected, bounded trace data to that provider. Local rules and browsing need no provider call.

The result records the rubric, provider, model, threshold, score and explanation. Model judgment is advisory evidence. Missing credentials, unavailable input/output, invalid responses, cancellation and provider failures produce an inconclusive check. Judge calls cannot run tools, execute test-definition code or select an arbitrary endpoint.

Anthropic grading uses its JSON-schema output format and requires a compatible model; Haiku 4.5 was exercised in live acceptance. OpenAI grading requests JSON-object output. Both providers' responses still undergo local score, explanation and completion validation. See [Anthropic's structured-output documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) for model compatibility.

Jobs expose progress and cancellation. Restarting the daemon preserves completed checks and marks unfinished work inconclusive; it does not silently resume external calls. A completed failure remains visible when another case is interrupted.

## MCP and API

The existing MCP server includes `eval_dataset`, `eval_run`, `eval_compare` and `eval_review`. These use the same `/api/evaluations` service as the UI. Starting a job returns its ID and state; clients can poll or cancel it. Model grading remains opt-in through MCP as well.

Dataset and experiment sizes, input acquisition, retained evidence, job count and provider responses are bounded. Redacted or truncated evidence is identified explicitly. The original trace replay and the application verification tools keep their existing roles.
