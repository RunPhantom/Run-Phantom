# Rust OpenAI chat

An Axum server that calls the OpenAI HTTP API directly and exports OTLP/HTTP
JSON without a product-specific telemetry crate.

```bash
export OPENAI_API_KEY=...
cargo run
```

Open <http://localhost:3018>. Run Phantom must be listening on
<http://localhost:5947>. To use another collector, set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to its full `/v1/traces` URL.

Optional: set `OPENAI_MODEL`; the default is `gpt-4o-mini`.
