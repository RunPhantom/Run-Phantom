# Credits

Several Run Phantom features were shaped by studying open-source LLM tracing,
agent monitoring and evaluation tools. This page names those projects, their
licences and the idea each one contributed, so their authors get credit and can
be contacted.

## How these projects were used

- **Ideas only, no source code.** Public documentation, changelogs and, for some
  projects, source files were read to understand behaviour. Every Run Phantom
  feature listed below was written from scratch in this repository's own stack:
  React, Radix primitives and hand-written SVG in the app, and Bun and SQLite in
  the daemon. No code, markup, styles, icons or copy text were copied.
- **Restricted licences.** Arize Phoenix and the AgentOps dashboard (`app/`) are
  under the Elastic License 2.0, and Langtrace is under AGPL-3.0. Lunary's
  canonical repository could not be checked. These projects informed ideas only.
  No feature draws on Langfuse's or Agenta's `ee/` directories, which use
  separate enterprise licences.
- **No new dependencies.** None of the features below added a package, so
  `THIRD_PARTY_NOTICES.md` is unchanged.
- **How the no-copy statement was checked.** Every source file added or changed
  between `0eb9d88` and `fee0f76` (pull requests #169 to #180) was searched for
  licence headers, copyright lines, SPDX tags, upstream project names and
  upstream URLs. None were found. The larger new modules were also read by
  hand: the command palette, fuzzy matcher, keyboard dispatcher, chart kit,
  waterfall, trace model, runs table and Playground word diff.

Licences are given as SPDX identifiers and were checked against each
repository's licence file on 2026-11-25. Where the repository holds code under
more than one licence, the licence of the part that was studied is named.

## Projects credited

| Project | Repository | Licence (SPDX) | Maintainer |
| --- | --- | --- | --- |
| Langfuse | https://github.com/langfuse/langfuse | `MIT` outside `ee/` directories (those use the Langfuse Enterprise License) | ClickHouse, Inc. (Langfuse team) |
| Opik | https://github.com/comet-ml/opik | `Apache-2.0` | Comet ML, Inc. |
| Laminar | https://github.com/lmnr-ai/lmnr | `Apache-2.0` | Laminar (lmnr-ai) |
| Arize Phoenix | https://github.com/Arize-ai/phoenix | `Elastic-2.0` (ideas only) | Arize AI |
| Helicone | https://github.com/Helicone/helicone | `Apache-2.0` | Helicone |
| AgentOps | https://github.com/AgentOps-AI/agentops | `MIT` for the SDK; `Elastic-2.0` for the `app/` dashboard that was studied (ideas only) | AgentOps |
| OpenLIT | https://github.com/openlit/openlit | `Apache-2.0` | OpenLIT |
| Langtrace | https://github.com/Scale3-Labs/langtrace | `AGPL-3.0` (the licence file does not say "only" or "or later"; ideas only) | Scale3 Labs |
| Lunary | https://github.com/lunary-ai/lunary (HTTP 404 on 2026-11-25) | Last published as `Apache-2.0`; unverifiable, treated as ideas only | Lunary |
| promptfoo | https://github.com/promptfoo/promptfoo | `MIT` | promptfoo |
| Agenta | https://github.com/Agenta-AI/agenta | `MIT` outside `ee/` and `web/website/` | Agenta |
| diff-match-patch | https://github.com/google/diff-match-patch (archived) | `Apache-2.0` | Google |
| OpenTelemetry semantic conventions | https://github.com/open-telemetry/semantic-conventions | `Apache-2.0` | OpenTelemetry (CNCF) |

## Features and their sources

### Command palette and keyboard map

Shipped in #176, with keys added in #177 to #180: Cmd/Ctrl+K palette, `?`
shortcut sheet, `g` then a letter to change page, `/` to focus search, and
`j`/`k` in lists and run detail.

| Source | Idea adapted |
| --- | --- |
| Langfuse (MIT) | A palette grouped into Recent, Go to and entity results; `j`/`k` for the next and previous item that ignore keys while typing or while a modifier is held. |
| promptfoo (MIT) | A Cmd/Ctrl+K shortcut that stands down while focus is in an input, textarea or editable element. |
| Agenta (MIT) | A `?` sheet that lists every shortcut, with shortcuts shown beside the actions they trigger. |
| Opik (Apache-2.0) | Visible `J`/`K` key hints on next and previous controls. |
| Helicone (Apache-2.0) | Arrow keys for the previous and next item and Esc to close in a detail view. |
| Lunary (ideas only) | Small key chips beside actions. |
| Arize Phoenix (Elastic-2.0, ideas only) | A global search palette on Cmd/Ctrl+K. |

### Dark theme

Shipped in #176. No open-source project was the source. The palette and
contrast targets come from Run Phantom's own design direction.

### Home overview dashboard and KPI sparklines

Shipped in #171 (API) and #177 (page and chart kit). The SVG chart kit was
written for Run Phantom and uses no chart library.

| Source | Idea adapted |
| --- | --- |
| Helicone (Apache-2.0) | A dashboard of KPI tiles and request, error, cost, latency and model panels. |
| Langfuse (MIT) | Curated latency and cost dashboards with p95 figures. |
| Opik (Apache-2.0), Laminar (Apache-2.0) | A project-level metrics dashboard beside the trace list. |
| Agenta (MIT) | Cost, latency and error charts over time with time-window presets. |
| AgentOps dashboard (Elastic-2.0, ideas only) | Run end-state and failures-over-time panels. |
| Arize Phoenix (Elastic-2.0, ideas only) | Small metric charts above lists that lead into the matching rows. |
| Langtrace (AGPL-3.0, ideas only), Lunary (ideas only) | Daily latency, token and cost trends on an overview page. |

### Runs table, saved views, live tail and bulk actions

Shipped in #171 (metric-rich run rows) and #178 (table, saved views, live tail,
bulk actions).

| Source | Idea adapted |
| --- | --- |
| Helicone (Apache-2.0) | A dense requests table with metric columns and a column chooser saved per table; named saved filters; a "Live" pill; select mode with bulk actions. |
| Agenta (MIT) | Input previews in table cells instead of raw JSON. |
| Laminar (Apache-2.0) | Saved table views that show when the current filters differ from the saved view. |
| Langfuse (MIT) | Saved table views. |
| Lunary (ideas only) | Saved views listed in the sidebar. |
| AgentOps dashboard (Elastic-2.0, ideas only) | Column toggles and faceted filters on the trace list; copy and export of trace JSON. |
| Langtrace (AGPL-3.0, ideas only) | A traces table; adding selected traces to a dataset. |

### Run detail: waterfall, step drawer, JSON viewer, in-trace search and j/k

Shipped in #179: nested waterfall rows, zoom and Fit, a docked and resizable
step drawer, a collapsible JSON viewer, Find step, kind filters, `j`/`k` and the
header stat strip.

| Source | Idea adapted |
| --- | --- |
| Langfuse (MIT) | A timeline that fits the whole trace and zooms with a Fit control to reset; searching across every step of a trace. |
| Laminar (Apache-2.0) | Timeline zoom controls; Cmd/Ctrl+F to search spans inside a trace; `j`/`k` between spans; token and cost badges on model rows; a formatted or raw view picker for payloads. |
| Opik (Apache-2.0) | Duration, token, cost and model shown on each tree row; a Pretty or JSON view for payloads. |
| Helicone (Apache-2.0) | A resizable detail drawer whose width is remembered; a one-line stats header. |
| AgentOps dashboard (Elastic-2.0, ideas only) | Span-type legend chips that filter the waterfall; a header with duration, cost, model calls, tool calls and errors. |
| Arize Phoenix (Elastic-2.0, ideas only) | A search box that filters the trace tree as you type. |

### Conversation tab with sub-agent cards

Shipped in #175 (sub-agent detection for the OpenTelemetry GenAI shape) and
#179 (cards).

| Source | Idea adapted |
| --- | --- |
| Laminar (Apache-2.0) | A transcript in reading order where each sub-agent is a collapsible card with duration, tokens, cost and input and output previews. |
| Langfuse (MIT) | One continuous log of a run for skimming agents that loop. |

### Tools offered versus tools called

Shipped in #179 in the step drawer.

| Source | Idea adapted |
| --- | --- |
| Langfuse (MIT) | Listing every tool available to a model call beside the tools it actually called. |

### Playground, multi-model compare and Open in Playground

Shipped in #172 (API) and #180 (workspace, compare, word diff, Open in
Playground from a model call).

| Source | Idea adapted |
| --- | --- |
| Langfuse (MIT) | Opening a captured model call in a playground with its messages and settings; side-by-side windows, each with its own model. |
| Opik (Apache-2.0) | An "Open in Playground" button on model-call spans; variants side by side with output, tokens, latency and a link to the recorded trace. |
| Helicone (Apache-2.0) | A playground link that carries the source request id and loads its messages, tools and parameters. |
| Agenta (MIT) | Variants compared side by side, each with its own model picker. |
| promptfoo (MIT) | Showing each output as a diff against a chosen base output. |
| diff-match-patch (Apache-2.0) | Its semantic cleanup step, which folds very short unchanged runs between two edits into one change. Run Phantom's word diff is its own LCS implementation. |
| OpenLIT (Apache-2.0) | A playground for comparing models on the same prompt. |
| Arize Phoenix (Elastic-2.0, ideas only) | Replaying a captured span with edits. |
| Langtrace (AGPL-3.0, ideas only), Lunary (ideas only) | Importing a captured conversation into a playground. |

### Offline list prices

Shipped in #169 and #174. No open-source project was the source. Every price
was read from the providers' public pricing pages, which are listed with the
as-of date in `src/pricing/list-prices.ts`.

### Multi-provider tool-agent example

Shipped in #175 as `examples/tool-agent`. The example has no dependencies.

| Source | Idea adapted |
| --- | --- |
| OpenTelemetry semantic conventions (Apache-2.0) | The GenAI attribute names and the `invoke_agent` / `execute_tool` / `chat` span shape that the example emits and Run Phantom reads. |

### Search match snippets

Shipped in #170. No open-source project was the source.

### Onboarding and connect flow

The Home empty state (#177) shows the OTLP endpoint, a "Connect a coding agent"
link and "Load sample runs". No open-source project was the source.

## Closed-source products

The research also read the public documentation of LangSmith, Braintrust, the
Weights & Biases Weave UI, the Pydantic Logfire platform, Honeycomb, Datadog,
Sentry and Vercel Observability. Their user interfaces are not open source, so
they gave ideas only and nothing could have been copied. For example, the live
tail on Runs draws on Logfire's documented Live view, and the waterfall layout
draws on the trace views that Honeycomb, Datadog and Sentry document.

## Contacting maintainers

Nobody has been contacted yet. These are the public channels each project
offers.

| Repository | Maintainer | Where to reach them |
| --- | --- | --- |
| langfuse/langfuse | ClickHouse, Inc. (Langfuse team) | https://github.com/langfuse/langfuse/discussions |
| comet-ml/opik | Comet ML, Inc. | https://github.com/comet-ml/opik/issues |
| lmnr-ai/lmnr | Laminar | https://github.com/lmnr-ai/lmnr/discussions |
| Arize-ai/phoenix | Arize AI | https://github.com/Arize-ai/phoenix/discussions |
| Helicone/helicone | Helicone | https://github.com/Helicone/helicone/discussions |
| AgentOps-AI/agentops | AgentOps | https://github.com/AgentOps-AI/agentops/discussions |
| openlit/openlit | OpenLIT | https://github.com/openlit/openlit/discussions |
| Scale3-Labs/langtrace | Scale3 Labs | https://github.com/Scale3-Labs/langtrace/discussions |
| promptfoo/promptfoo | promptfoo | https://github.com/promptfoo/promptfoo/issues |
| Agenta-AI/agenta | Agenta | https://github.com/Agenta-AI/agenta/discussions |
| open-telemetry/semantic-conventions | OpenTelemetry (CNCF) | https://github.com/open-telemetry/semantic-conventions/issues |
| google/diff-match-patch | Google | Repository is archived and read-only; no open channel. |
| lunary-ai/lunary | Lunary | Repository unavailable (HTTP 404 on 2026-11-25); no public channel verified. |
