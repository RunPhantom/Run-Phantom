# OpenAI chat

A minimal TypeScript chat server that calls the official OpenAI SDK directly
and exports one agent root plus one LLM span using OTLP/HTTP JSON.

```bash
export OPENAI_API_KEY=...
bun install
bun run dev
```

Open <http://localhost:3012>. Run Phantom must be listening on
<http://localhost:5947>. To use another collector, set the standard
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` variable to its full `/v1/traces` URL.

Optional: set `OPENAI_MODEL`; the default is `gpt-4o-mini`.
