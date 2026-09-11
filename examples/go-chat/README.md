# Go OpenAI chat

A dependency-free Go server that calls the OpenAI HTTP API directly and
exports OTLP/HTTP JSON with the standard library.

```bash
export OPENAI_API_KEY=...
go run .
```

Open <http://localhost:3019>. Run Phantom must be listening on
<http://localhost:5947>. To use another collector, set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to its full `/v1/traces` URL.

Optional: set `OPENAI_MODEL`; the default is `gpt-4o-mini`.
