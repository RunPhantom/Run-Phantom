# Run Phantom examples

These small programs call model providers directly and export traces to Run
Phantom with vendor-neutral OTLP/HTTP JSON. No Run Phantom SDK is required.

Start with [`tool-agent`](./tool-agent) to see tool calls, failures,
multi-turn conversations and a sub-agent. The chat servers show the smallest
possible integration in each language.

Run the application first from the repository root:

```bash
bun install
bun run dev
```

The default trace endpoint is <http://localhost:5947/v1/traces>. Override it
with the standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` environment variable.

## Examples

| Example | Provider and instrumentation | Runtime | Port |
| --- | --- | --- | --- |
| [`tool-agent`](./tool-agent) | OpenAI, Anthropic or Gemini HTTP APIs + OpenTelemetry GenAI spans | Bun, no dependencies | CLI |
| [`openai-chat`](./openai-chat) | Official OpenAI SDK + OTLP/HTTP JSON | Bun | 3012 |
| [`anthropic-chat`](./anthropic-chat) | Official Anthropic SDK + OTLP/HTTP JSON | Bun | 3013 |
| [`python-chat`](./python-chat) | Official OpenAI Python SDK + OTLP/HTTP JSON | Python | 3017 |
| [`rust-chat`](./rust-chat) | OpenAI HTTP API + OTLP/HTTP JSON | Rust | 3018 |
| [`go-chat`](./go-chat) | OpenAI HTTP API + OTLP/HTTP JSON | Go | 3019 |

Each directory has exact setup instructions. Provider calls require
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or, for `tool-agent`, `GEMINI_API_KEY`;
exporting traces requires a running Run Phantom daemon. The examples print or
return a link to the run after they export its trace.

## Trace shape

Every chat-server request exports one `agent_root` span and one child
`llm_call` span. `tool-agent` exports an `invoke_agent` root with a model span
per step, an `execute_tool` span per tool call, and a nested `invoke_agent`
span for its sub-agent. The payloads use standard OTLP `resourceSpans` and
OpenTelemetry GenAI attributes, plus the `runphantom.*` identifiers that name
the run and group conversation turns. This keeps transport independent of any
product-specific client library.

## Validation

```bash
bun run check
python -m py_compile python-chat/server.py
(cd go-chat && go test ./...)
(cd rust-chat && cargo check)
```
