# Run Phantom

Run Phantom is a local-first debugger for AI-agent runs. It captures traces,
spans, tool calls, replay state, and local agent context so you can inspect what
happened instead of guessing.

Owned and maintained by Divyam Talwar, who holds all rights in the software.

**See the run. Find the reason.**

## What It Does

- Runs a local daemon and UI for inspecting agent runs
- Ingests OTLP traces and stores them in SQLite
- Searches, annotates, saves, exports, and compares trace evidence
- Replays captured runs against project-owned local replay endpoints
- Opens trace-aware Claude Code or Codex sessions when those local CLIs are installed
- Exposes MCP and CLI entry points for supported local workflows
- Ships as source-first code from this repository

## Build and Run

Run Phantom requires Bun 1.4.0 or newer.

```bash
bun install --frozen-lockfile
bun run dev
```

`bun run dev` starts the daemon on `:5947` and the Vite UI on `:5948` by
default.

To run the example suite:

```bash
bun run dev:examples
```

## CLI

From a source checkout the CLI is not on your `PATH`. `bun install` links a
`runphantom-dev` wrapper into `node_modules/.bin`, so invoke it with `bun x`:

```bash
bun x runphantom-dev            # start the daemon and open the UI
bun x runphantom-dev serve      # run in the foreground
bun x runphantom-dev start      # run in the background
bun x runphantom-dev stop
bun x runphantom-dev status
bun x runphantom-dev open
bun x runphantom-dev connect    # configure this project for local OTLP export
bun x runphantom-dev setup      # install skills and MCP into supported agents
bun x runphantom-dev reset      # delete local traces after confirmation
bun x runphantom-dev mcp        # serve MCP over stdio
bun x runphantom-dev sync
bun x runphantom-dev replay register
bun x runphantom-dev uninstall
```

`bun x runphantom-dev --help` prints the authoritative list.

To get a real `runphantom` binary on your `PATH`, build and install it from
this checkout:

```bash
bun run install:local
```

Environment overrides:

| Env var | Purpose | Default |
| --- | --- | --- |
| `RUNPHANTOM_PORT` | HTTP + WebSocket port | `5947` |
| `RUNPHANTOM_BIND_HOST` | Daemon bind address | `127.0.0.1` |
| `RUNPHANTOM_UI_PORT` | Vite dev UI port | `5948` |
| `RUNPHANTOM_DB_PATH` | SQLite database file | `~/.runphantom/runphantom.db` |
| `RUNPHANTOM_ALLOWED_HOSTS` | Comma-separated extra `Host` header names | unset |
| `RUNPHANTOM_ALLOWED_SOURCE_IPS` | Exact non-loopback client IPs to permit | unset |
| `RUNPHANTOM_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to mutate | unset |
| `RUNPHANTOM_URL` | Daemon URL used by the MCP bridge | `http://127.0.0.1:5947` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Standard OTLP trace target for examples and integrations | `http://127.0.0.1:5947/v1/traces` |

No API key or LLM is required for capture, storage, inspection, search,
annotations, downloads, MCP trace tools, or local replay routing. Optional AI
features use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a locally installed and
authenticated Claude Code or Codex CLI. `.env.example` documents every
variable, including which component reads it.

## Source-First Install

This repository is the source distribution. There is no external installer flow
in this tree.

Use the local checkout directly:

```bash
bun install --frozen-lockfile
bun run dev
```

The daemon, React UI, SQLite schema, CLI, MCP server, examples, tests, and build
scripts are present in this tree. Core capture and inspection do not depend on a
closed Run Phantom service. Optional OpenAI, Anthropic, Claude Code, and Codex
features still depend on those third-party providers or locally installed tools.

## Development Checks

```bash
bun run build
bun run test
bun run lint
bun x tsc --noEmit
```

For the UI package:

```bash
cd app
bun x tsc --noEmit
bun run build
```

## Examples

The `examples/` directory contains single-file demo apps that exercise the
local daemon, trace ingestion, and replay flow from different SDKs and runtimes.

```bash
bun run dev:examples
```

## Documentation

- [Agent guide](./AGENTS.md) — build, test, and contribution rules for this repository
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

The CLI is self-documenting: `bun x runphantom-dev --help` lists every
subcommand, and `.env.example` documents every environment variable with the
source location that reads it.

## License

MIT, copyright Divyam Talwar. See [`LICENSE`](./LICENSE) for the notice and
terms that must be retained in copies and substantial portions of the software.
Third-party names referenced in this repository remain the property of their
respective owners; see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
