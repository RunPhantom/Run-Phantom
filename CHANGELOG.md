# Changelog

Notable changes to Run Phantom. Entries link to the pull request that made them.
Run Phantom has no tagged releases yet, so everything below is unreleased.

## Unreleased

### Added

- **Home overview.** Opening Run Phantom now shows how your agents are doing:
  runs, error rate, p95 duration, tokens and cost for the last hour, day, week
  or month, each with a sparkline and a change against the previous window.
  It also shows runs per time bucket, runs that need a look, agent and model
  tables, and the latest activity. Every tile and row links to the matching
  runs, and charts can be read as a table.
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
- **Overview and run list API.** `GET /api/overview` returns KPIs and time
  buckets. `GET /api/runs` adds per-run duration, tokens, cost, tool calls and
  errors, with filters, sorting and cursor pages.
  ([#171](https://github.com/RunPhantom/Run-Phantom/pull/171))

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
- A Cost & usage check now formats sub-cent amounts the same way the app does.
  ([#173](https://github.com/RunPhantom/Run-Phantom/pull/173))
