from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import ClientSession, web
from openai import AsyncOpenAI


def load_env() -> None:
    known = set(os.environ)
    for directory in reversed((Path(__file__).resolve().parent, *Path(__file__).resolve().parents)):
        for name in (".env", ".env.local"):
            path = directory / name
            if not path.is_file():
                continue
            for raw_line in path.read_text().splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.removeprefix("export ").split("=", 1)
                key = key.strip()
                if key and key not in known:
                    os.environ[key] = value.strip().strip("'\"")


load_env()

OTLP_ENDPOINT = os.getenv(
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://localhost:5947/v1/traces"
)
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")


def attr(key: str, value: str | int | bool) -> dict:
    if isinstance(value, bool):
        encoded = {"boolValue": value}
    elif isinstance(value, int):
        encoded = {"intValue": str(value)}
    else:
        encoded = {"stringValue": value}
    return {"key": key, "value": encoded}


def span(
    trace_id: str,
    span_id: str,
    name: str,
    started_ns: int,
    ended_ns: int,
    attributes: dict[str, str | int | bool],
    parent_span_id: str | None = None,
    error: str | None = None,
) -> dict:
    result = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "startTimeUnixNano": str(started_ns),
        "endTimeUnixNano": str(ended_ns),
        "attributes": [attr(key, value) for key, value in attributes.items()],
        "status": {"code": 2, "message": error} if error else {"code": 1},
    }
    if parent_span_id:
        result["parentSpanId"] = parent_span_id
    return result


async def export_trace(spans: list[dict]) -> None:
    body = {
        "resourceSpans": [
            {
                "resource": {"attributes": [attr("service.name", "runphantom-examples")]},
                "scopeSpans": [
                    {
                        "scope": {"name": "runphantom.examples", "version": "1.0.0"},
                        "spans": spans,
                    }
                ],
            }
        ]
    }
    async with ClientSession() as session:
        async with session.post(OTLP_ENDPOINT, json=body) as response:
            if response.status >= 400:
                raise RuntimeError(f"OTLP export failed ({response.status})")


def run_url(trace_id: str) -> str:
    parsed = urlsplit(OTLP_ENDPOINT)
    return f"{parsed.scheme}://{parsed.netloc}/runs/{trace_id}"


PAGE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Run Phantom · Python OpenAI</title>
  <style>
    :root{color-scheme:light;font-family:"Avenir Next","Segoe UI",ui-sans-serif,system-ui,sans-serif;--canvas:#F8F4EE;--canvas-bright:#FFFBF6;--surface:#FFFBF6;--surface-raised:#F2EADF;--ink:#302730;--muted:#6C616C;--border:#9C8870;--accent:#B83C24;--mark-accent:#C7462D;--accent-strong:#9F301D;--accent-ink:#FFFBF6;--link:#275EA8;--focus:#9F301D}
    *{box-sizing:border-box}
    body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--canvas);color:var(--ink)}
    main{width:min(760px,100%);padding:clamp(24px,4vw,40px);border:1px solid var(--border);border-radius:28px;background:var(--surface);box-shadow:0 24px 60px rgba(48,39,48,.14)}
    .brand{display:flex;gap:16px;align-items:flex-start}
    .brand-mark{flex:0 0 auto;display:block;width:52px;height:52px;color:var(--ink)}
    .eyebrow{margin:2px 0 6px;color:var(--muted);font:600 .74rem/1.3 "SFMono-Regular",Consolas,"Liberation Mono",monospace;letter-spacing:.16em;text-transform:uppercase}
    h1{margin:0;font-family:"Avenir Next Condensed","Arial Narrow","Segoe UI Variable Display",sans-serif;letter-spacing:-.04em;font-size:clamp(2rem,5vw,3rem);line-height:1.03}
    .tagline{margin:16px 0 8px;color:var(--accent);font-size:1rem;font-weight:700}
    p{margin:0;color:var(--muted);line-height:1.6}
    form{display:grid;gap:14px;margin-top:28px}
    label{font-size:.92rem;font-weight:700;color:var(--ink)}
    textarea,button{border-radius:18px;border:1px solid var(--border);padding:14px 16px;font:inherit}
    textarea{min-height:136px;resize:vertical;background:var(--surface-raised);color:var(--ink);box-shadow:inset 0 1px 0 rgba(255,255,255,.7)}
    textarea::placeholder{color:var(--muted)}
    textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
    .actions{display:grid;gap:12px;align-items:center}
    .hint{font-size:.95rem}
    button{width:auto;min-width:200px;justify-self:start;background:var(--accent);color:var(--accent-ink);font-weight:750;cursor:pointer;box-shadow:0 12px 24px rgba(184,60,36,.2);transition:transform 160ms ease,background-color 160ms ease,box-shadow 160ms ease}
    button:hover:not(:disabled){transform:translateY(-1px);background:var(--accent-strong);box-shadow:0 16px 28px rgba(159,48,29,.24)}
    button:disabled{opacity:.6;cursor:wait;transform:none;box-shadow:none}
    #result{min-width:0;min-height:52px;margin-top:22px;padding-top:18px;border-top:1px solid var(--border);color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
    a{color:var(--link);font-weight:700;text-underline-offset:.16em}
    @media (min-width:640px){.actions{grid-template-columns:1fr auto;gap:16px;align-items:end}}
    @media (max-width:640px){body{padding:16px}main{padding:22px;border-radius:22px}.brand{gap:12px}.brand-mark{width:46px;height:46px}button{width:100%;min-width:0}}
    @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
          <rect width="64" height="64" rx="16" fill="var(--surface-raised)"></rect>
          <path d="M12 26V12H26M38 52H52V38" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></path>
          <path d="M12 42C20 42 20 22 30 22C40 22 39 42 52 42" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"></path>
          <circle cx="30" cy="22" r="5" fill="var(--mark-accent)"></circle>
        </svg>
        <div>
          <p class="eyebrow">Run Phantom example</p>
          <h1>Run Phantom · Python OpenAI</h1>
        </div>
      </div>
      <p class="tagline">See the run. Find the reason.</p>
      <p>Provider-direct OpenAI with vendor-neutral OTLP/HTTP export.</p>
    </header>
    <form id="chat">
      <label for="message">Prompt</label>
      <textarea id="message" name="message" required placeholder="Ask the model something."></textarea>
      <div class="actions">
        <p class="hint">This sends one provider-direct request and exports the trace to your local Run Phantom daemon.</p>
        <button>Send and trace</button>
      </div>
    </form>
    <p id="result" role="status" aria-live="polite"></p>
  </main>
  <script>
    const f=document.querySelector('#chat'),r=document.querySelector('#result');
    f.addEventListener('submit',async e=>{
      e.preventDefault();
      const b=f.querySelector('button');
      b.disabled=true;
      r.textContent='Running...';
      try{
        const x=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:new FormData(f).get('message')})}),j=await x.json();
        if(!x.ok)throw Error(j.error||'Request failed');
        r.replaceChildren(document.createTextNode(j.text+'\\n'),Object.assign(document.createElement('a'),{href:j.runUrl,textContent:'Open in Run Phantom'}));
      }catch(e){
        r.textContent=e.message;
      }finally{
        b.disabled=false;
      }
    })
  </script>
</body>
</html>"""


async def index(_: web.Request) -> web.Response:
    return web.Response(text=PAGE, content_type="text/html")


async def chat(request: web.Request) -> web.Response:
    body = await request.json()
    message = body.get("message", "")
    if not isinstance(message, str) or not message.strip():
        return web.json_response({"error": "message is required"}, status=400)
    if not os.getenv("OPENAI_API_KEY"):
        return web.json_response({"error": "OPENAI_API_KEY is not configured"}, status=503)

    messages = [{"role": "user", "content": message.strip()}]
    trace_id, root_id, llm_id = secrets.token_hex(16), secrets.token_hex(8), secrets.token_hex(8)
    event_id = secrets.token_hex(16)
    root_started, llm_started = time.time_ns(), time.time_ns()

    try:
        result = await AsyncOpenAI().chat.completions.create(model=MODEL, messages=messages)
        output = result.choices[0].message.model_dump()
        text = result.choices[0].message.content or ""
        ended = time.time_ns()
        usage = result.usage
        spans = [
            span(
                trace_id,
                root_id,
                "python-openai-chat",
                root_started,
                ended,
                {
                    "runphantom.span.kind": "agent_root",
                    "runphantom.event.id": event_id,
                    "runphantom.event.name": "python-openai-chat",
                    "runphantom.input": json.dumps(messages),
                    "runphantom.output": json.dumps(output),
                },
            ),
            span(
                trace_id,
                llm_id,
                "openai.chat.completions",
                llm_started,
                ended,
                {
                    "runphantom.span.kind": "llm_call",
                    "gen_ai.operation.name": "chat",
                    "gen_ai.provider.name": "openai",
                    "gen_ai.request.model": result.model,
                    "gen_ai.input.messages": json.dumps(messages),
                    "gen_ai.output.messages": json.dumps([output]),
                    "gen_ai.usage.input_tokens": usage.prompt_tokens if usage else 0,
                    "gen_ai.usage.output_tokens": usage.completion_tokens if usage else 0,
                },
                parent_span_id=root_id,
            ),
        ]
        await export_trace(spans)
        return web.json_response({"text": text, "runUrl": run_url(trace_id)})
    except Exception as error:
        detail = str(error)
        ended = time.time_ns()
        input_json = json.dumps(messages)
        output_json = json.dumps({"error": detail})
        failed_spans = [
            span(
                trace_id,
                root_id,
                "python-openai-chat",
                root_started,
                ended,
                {
                    "runphantom.span.kind": "agent_root",
                    "runphantom.event.id": event_id,
                    "runphantom.event.name": "python-openai-chat",
                    "runphantom.input": input_json,
                    "runphantom.output": output_json,
                },
                error=detail,
            ),
            span(
                trace_id,
                llm_id,
                "openai.chat.completions",
                llm_started,
                ended,
                {
                    "runphantom.span.kind": "llm_call",
                    "gen_ai.operation.name": "chat",
                    "gen_ai.provider.name": "openai",
                    "gen_ai.request.model": MODEL,
                    "gen_ai.input.messages": input_json,
                    "gen_ai.output.messages": output_json,
                },
                parent_span_id=root_id,
                error=detail,
            ),
        ]
        try:
            await export_trace(failed_spans)
        except Exception:
            pass
        return web.json_response({"error": detail, "runUrl": run_url(trace_id)}, status=500)


app = web.Application(client_max_size=64 * 1024)
app.add_routes([web.get("/", index), web.post("/api/chat", chat)])

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=int(os.getenv("PORT", "3017")))
