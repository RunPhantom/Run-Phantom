# Changelog

Notable changes to Run Phantom. Entries link to the pull request that made them.
Run Phantom has no tagged releases yet, so everything below is unreleased.

## Unreleased

### Added

- **Home overview.** Opening Run Phantom now shows how your agents are doing:
  runs, error rate, p95 duration, tokens and cost for the last hour, day, week
  or month, each with a sparkline and a change against the previous window.
  It also shows runs per time bucket, runs that need a look, agent and model
  tables, and the latest activity. Tiles and named agent and model rows link
  to the matching runs, and charts can be read as a table.
  ([#171](https://github.com/RunPhantom/Run-Phantom/pull/171),
  [#177](https://github.com/RunPhantom/Run-Phantom/pull/177))
- **Runs table.** Runs are a full-width table with status, agent, input
  preview, model, duration, tokens, cost, errors and start time. You can sort
  and filter it, choose columns, and select several runs to compare, export,
  add to a test set or delete. New runs stream in live, and the list pauses
  while you scroll or select.
  ([#178](https://github.com/RunPhantom/Run-Phantom/pull/178))
- **Saved views.** Save the current Runs filters and sort as a named view. Views
  appear in the sidebar with live counts and show when you have unsaved
  changes. ([#178](https://github.com/RunPhantom/Run-Phantom/pull/178))
- **Run detail waterfall.** Steps appear as a nested waterfall with kind
  filters, zoom and Fit, Find step, a jump through failed steps, and `j`/`k`
  navigation. A docked, resizable step drawer shows the error first, then input
  and output, the tools offered and called, timing, usage, cost and every
  attribute in a collapsible JSON viewer. The run header states why a run
  failed in one sentence and shows a stat strip.
  ([#179](https://github.com/RunPhantom/Run-Phantom/pull/179))
- **Sub-agent cards.** The Conversation tab shows each sub-agent as a
  collapsible card with tokens, cost and an output preview. Sub-agents from
  OpenTelemetry GenAI traces (`execute_tool` > `invoke_agent` > `chat`) are now
  detected. ([#175](https://github.com/RunPhantom/Run-Phantom/pull/175),
  [#179](https://github.com/RunPhantom/Run-Phantom/pull/179))
- **Playground.** Write a prompt and run it on up to three OpenAI, Anthropic
  or Gemini models side by side, with streaming output, latency, time to first
  token, tokens, estimated cost and a word diff against a base you choose. Each
  call is recorded as a run, and History reloads earlier runs. **Open in
  Playground** on a model call in run detail loads that call into the editor.
  ([#172](https://github.com/RunPhantom/Run-Phantom/pull/172),
  [#180](https://github.com/RunPhantom/Run-Phantom/pull/180))
- **Gemini API key.** Settings has a slot for a Google Gemini key alongside
  OpenAI and Anthropic.
  ([#172](https://github.com/RunPhantom/Run-Phantom/pull/172))
- **Command palette and shortcuts.** Cmd/Ctrl+K opens a palette to go to a
  page, open a recent run, search, or run an action. `?` lists every keyboard
  shortcut, and `g` followed by a letter changes page.
  ([#176](https://github.com/RunPhantom/Run-Phantom/pull/176))
- **Dark theme.** An opt-in dark theme, with light, dark or system set from
  the header or the palette.
  ([#176](https://github.com/RunPhantom/Run-Phantom/pull/176))
- **Offline cost estimates.** Bundled, dated list prices for OpenAI, Anthropic
  and Google Gemini models estimate cost without network access, including
  cached input and dated model ids. Estimates are labelled with the price-list
  date. ([#169](https://github.com/RunPhantom/Run-Phantom/pull/169),
  [#174](https://github.com/RunPhantom/Run-Phantom/pull/174))
- **Search match context.** Each search result shows why it matched, with the
  matching text highlighted and the number of matching steps.
  ([#170](https://github.com/RunPhantom/Run-Phantom/pull/170))
- **Tool-calling agent example.** `examples/tool-agent` is a dependency-free
  agent that calls OpenAI, Anthropic or Gemini with real tool calls, exports
  OpenTelemetry GenAI traces to Run Phantom, and includes a scenario runner.
  ([#175](https://github.com/RunPhantom/Run-Phantom/pull/175))
- **Connect an agent.** A guide with tabs for TypeScript or Node, Python,
  OpenTelemetry, curl and coding agents, each filled in with the daemon's real
  port, plus **Send a test span** to check the connection. The page shows the
  new run as soon as it arrives. `/health` now reports whether the daemon runs
  from source or a binary.
  ([#185](https://github.com/RunPhantom/Run-Phantom/pull/185))
- **Teaching empty states.** Empty Runs, Home and Playground history show a
  faded, labelled sample of what will appear there, next to the next step to
  take. Sample runs are marked **Sample** in the runs table.
  ([#185](https://github.com/RunPhantom/Run-Phantom/pull/185))
- **Provider checks and local data in Settings.** Each provider key can be
  tested with one models-list request, and Settings says which key is in use.
  **Data and debug** shows where runs are stored, downloads a backup and
  deletes all runs while keeping saved ones, and the pricing note explains
  reported, bundled and public prices in plain words.
  ([#184](https://github.com/RunPhantom/Run-Phantom/pull/184))
- **Saved runs table.** Saved runs are a table with status, model and cost,
  with bulk export and removal.
  ([#184](https://github.com/RunPhantom/Run-Phantom/pull/184))
- **Credits and changelog.** `CREDITS.md` names the open-source projects whose
  ideas shaped recent features, with their licences, and this changelog lists
  unreleased changes.
  ([#186](https://github.com/RunPhantom/Run-Phantom/pull/186))
- **Overview and run list API.** `GET /api/overview` returns KPIs and time
  buckets. `GET /api/runs` adds per-run duration, tokens, cost, tool calls and
  errors, with filters, sorting and cursor pages. It also accepts an exact
  `ids` filter, repeated once per run id.
  ([#171](https://github.com/RunPhantom/Run-Phantom/pull/171),
  [#182](https://github.com/RunPhantom/Run-Phantom/pull/182))

### Changed

- **Workspace layout.** A header holds the palette, the theme toggle and the
  Ask button (Cmd/Ctrl+J). The sidebar is grouped into Debug, Improve and Ship,
  with counts for runs, saved runs and review drafts, and Home comes first.
  ([#176](https://github.com/RunPhantom/Run-Phantom/pull/176),
  [#177](https://github.com/RunPhantom/Run-Phantom/pull/177))
- **One run status everywhere.** The run header, runs list, search and MCP
  tools now agree on status. A tool error under a successful run reads
  "completed with errors"; "failed" means the run itself failed.
  ([#169](https://github.com/RunPhantom/Run-Phantom/pull/169))
- **`status=completed` no longer includes runs with errors.** Run search,
  typed filters (including `status ne completed`), saved views and MCP tools
  now use the same status filters as the Runs page: `completed` means finished
  with no errors, and `completed_with_errors` is its own value. Saved searches,
  bookmarked URLs and MCP clients that relied on the old meaning should add
  `completed_with_errors`. Failed or cancelled replays, interrupted runs and
  runs with no recorded end no longer count as running anywhere.
  ([#188](https://github.com/RunPhantom/Run-Phantom/pull/188))
- **Error counts no longer count a failed run twice.** When a run's root step
  fails because a step inside it failed, the run reads "Run failed" with the
  inner errors counted once, so a rejected Playground call shows 1 error.
  Search treats a partial coding-hook capture by its span evidence, while the
  Runs page shows it as "Completion unavailable".
  ([#188](https://github.com/RunPhantom/Run-Phantom/pull/188))
- **Cost estimates on by default.** Runs, the overview, the run list and Cost
  & usage all price a model call by the same rule. Costs under a cent keep two
  significant digits.
  ([#169](https://github.com/RunPhantom/Run-Phantom/pull/169),
  [#174](https://github.com/RunPhantom/Run-Phantom/pull/174))
- **Saved-run summaries stay local.** Saving a run writes a local summary.
  Sending text to a provider for a summary is now an explicit action that says
  where the text goes and removes credentials first.
  ([#170](https://github.com/RunPhantom/Run-Phantom/pull/170))
- **Type scale and contrast.** Text sizes, page spacing and motion follow one
  shared scale, and low-contrast grey text is darker.
  ([#176](https://github.com/RunPhantom/Run-Phantom/pull/176))
- **Cost & usage around spend.** The page leads with spend, model calls and
  tokens, then breaks them down by model and by agent and lists the most
  expensive runs. Partly priced totals end in `+`, and "Rates used" explains
  each rate in plain words.
  ([#182](https://github.com/RunPhantom/Run-Phantom/pull/182))
- **Search results in the runs table.** Search shows matching runs with the
  same columns as Runs, plus match snippets.
  ([#182](https://github.com/RunPhantom/Run-Phantom/pull/182))
- **Sorting by cost.** Runs sort by their estimated cost, or by the priced
  part of a run that is only partly priced, so the order matches the `$x+`
  values in the table.
  ([#182](https://github.com/RunPhantom/Run-Phantom/pull/182))
- **Evaluations, Review queues and Prompts.** Evaluations leads with datasets,
  pass rates and what changed since the previous experiment. Review queues
  lead with a queue table, Prompts gets a sample library, and all three use
  plain copy and labelled fields.
  ([#183](https://github.com/RunPhantom/Run-Phantom/pull/183))
- **Verification.** The page starts with a summary and numbered pairing steps
  in plain copy. ([#184](https://github.com/RunPhantom/Run-Phantom/pull/184))
- **Agent names.** Runs show the agent named by `gen_ai.agent.name` or
  `agent.name` on the root span or an agent span directly under it, instead of
  the run title. Runs, Home, search, the run outline and MCP tools use the same
  rule. ([#181](https://github.com/RunPhantom/Run-Phantom/pull/181))
- **Provider keys.** A key saved in Settings now takes precedence over
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`. Settings and the
  summary consent dialog name the environment key when one is in use.
  ([#181](https://github.com/RunPhantom/Run-Phantom/pull/181),
  [#184](https://github.com/RunPhantom/Run-Phantom/pull/184))
- **Private state folder.** `~/.runphantom` is created readable only by its
  owner. ([#185](https://github.com/RunPhantom/Run-Phantom/pull/185))
- **Touch targets.** Controls stay at least 44 px on phones and tablets.
  ([#185](https://github.com/RunPhantom/Run-Phantom/pull/185))
- **Sample runs** record `claude-sonnet-5-5`, so opening one in the Playground
  no longer substitutes another model.
  ([#181](https://github.com/RunPhantom/Run-Phantom/pull/181))

### Fixed

- Searching for "error" or "failed" now finds failed runs and ranks them first.
  ([#170](https://github.com/RunPhantom/Run-Phantom/pull/170))
- Runs are marked interrupted only after ten minutes of silence and real
  evidence, not earlier.
  ([#169](https://github.com/RunPhantom/Run-Phantom/pull/169))
- Guard and token-usage panels appear only when there is evidence to show, and
  run evidence links point to pages that work.
  ([#170](https://github.com/RunPhantom/Run-Phantom/pull/170))
- The overview and run list no longer show most costs as unknown; calls routed
  through Bedrock, Azure or an unidentified provider stay unpriced instead of
  being priced at first-party rates.
  ([#174](https://github.com/RunPhantom/Run-Phantom/pull/174))
- Cancelled or broken model streams record unknown token counts with a
  warning instead of a placeholder count.
  ([#172](https://github.com/RunPhantom/Run-Phantom/pull/172))
- The cost breakdown no longer opens on top of the button that opens it, and
  the Saved filter is labelled by run name.
  ([#181](https://github.com/RunPhantom/Run-Phantom/pull/181))
- Search keeps every result when its run facts cannot be loaded, and shows `—`
  with a notice instead.
  ([#182](https://github.com/RunPhantom/Run-Phantom/pull/182))
- Experiments are compared only with earlier experiments that used the same
  evaluator and snapshot versions, and older pass rates are labelled.
  ([#183](https://github.com/RunPhantom/Run-Phantom/pull/183))
- OpenAI model graders leave room for reasoning tokens, so they no longer run
  out of output before answering.
  ([#183](https://github.com/RunPhantom/Run-Phantom/pull/183))
- Closing the New dataset, New experiment or New review queue dialog returns
  focus to the button that opened it.
  ([#183](https://github.com/RunPhantom/Run-Phantom/pull/183))
- The provider connection check tests the key the app actually uses, and
  repeated checks within 15 seconds reuse the last answer instead of calling
  the provider again.
  ([#184](https://github.com/RunPhantom/Run-Phantom/pull/184))
- Deleting runs no longer reports a stale count or loses keyboard focus.
  ([#184](https://github.com/RunPhantom/Run-Phantom/pull/184))
- Provider names that start with a vowel read "an OpenAI key", not "a OpenAI
  key". ([#185](https://github.com/RunPhantom/Run-Phantom/pull/185))
- Runs, Search, Home and the Playground now derive a run's status the same
  way, and Home's buckets start on local hour and day boundaries, including on
  days with a skipped midnight or a half-hour clock change.
  ([#188](https://github.com/RunPhantom/Run-Phantom/pull/188))
- The Conversation tab follows the same causal order as the Overview, so a
  failed run ends on its failure; nested sub-agents appear as cards that agree
  with the sub-agent view; and a zoomed Span Tree no longer draws later steps
  at its edge. ([#189](https://github.com/RunPhantom/Run-Phantom/pull/189))
- Open in Playground replays Gemini function calls with the signature Gemini
  requires, unwraps AI SDK v5 tool output, and says when it swaps the captured
  model, including "-latest" ids. The command palette finds runs by any of
  their names, in any word order.
  ([#190](https://github.com/RunPhantom/Run-Phantom/pull/190))
- Pages no longer download the full run list on every visit or while runs
  stream in. The runs table sizes its columns to their content, and the span
  drawer keeps the time track visible at laptop widths.
  ([#191](https://github.com/RunPhantom/Run-Phantom/pull/191))

### Internal

- An end-to-end Cost & usage test now expects the app's sub-cent formatting.
  ([#173](https://github.com/RunPhantom/Run-Phantom/pull/173))
- Agent-name, Home drill-down and Playground model-substitution tests were
  tightened, and the native Git fixture now reports why it was not ready and
  always cleans up its child processes.
  ([#181](https://github.com/RunPhantom/Run-Phantom/pull/181))
