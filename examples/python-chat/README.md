# Python OpenAI chat

An `aiohttp` server that calls the official OpenAI Python SDK directly and
exports OTLP/HTTP JSON without a product-specific telemetry package.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=...
python server.py
```

Open <http://localhost:3017>. Run Phantom must be listening on
<http://localhost:5947>. To use another collector, set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to its full `/v1/traces` URL.

Optional: set `OPENAI_MODEL`; the default is `gpt-4o-mini`.
