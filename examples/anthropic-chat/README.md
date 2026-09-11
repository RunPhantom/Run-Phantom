# Anthropic chat

A minimal TypeScript chat server that calls the official Anthropic SDK
directly and exports one agent root plus one LLM span using OTLP/HTTP JSON.

```bash
export ANTHROPIC_API_KEY=...
bun install
bun run dev
```

Open <http://localhost:3013>. Run Phantom must be listening on
<http://localhost:5947>. To use another collector, set the standard
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` variable to its full `/v1/traces` URL.

Optional: set `ANTHROPIC_MODEL`; the default is `claude-sonnet-5`.
