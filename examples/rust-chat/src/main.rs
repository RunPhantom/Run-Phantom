use axum::{
    extract::State,
    http::StatusCode,
    response::Html,
    routing::{get, post},
    Json, Router,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Run Phantom · Rust OpenAI</title>
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
          <h1>Run Phantom · Rust OpenAI</h1>
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
        r.replaceChildren(document.createTextNode(j.text+'\n'),Object.assign(document.createElement('a'),{href:j.runUrl,textContent:'Open in Run Phantom'}));
      }catch(e){
        r.textContent=e.message;
      }finally{
        b.disabled=false;
      }
    })
  </script>
</body>
</html>"#;

static SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct AppState {
    client: Client,
    api_key: Option<String>,
    model: String,
    otlp_endpoint: String,
}

#[derive(Deserialize)]
struct ChatInput {
    message: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Message {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: Message,
}

#[derive(Deserialize)]
struct Usage {
    prompt_tokens: u64,
    completion_tokens: u64,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    model: String,
    choices: Vec<OpenAiChoice>,
    usage: Option<Usage>,
}

fn now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos()
}

fn id(bytes: usize) -> String {
    let mixed = now_ns()
        ^ ((std::process::id() as u128) << 64)
        ^ (SEQUENCE.fetch_add(1, Ordering::Relaxed) as u128);
    if bytes == 16 {
        format!("{mixed:032x}")
    } else {
        format!("{:016x}", mixed as u64)
    }
}

fn attr(key: &str, value: Value) -> Value {
    let encoded = match value {
        Value::Bool(value) => json!({ "boolValue": value }),
        Value::Number(value) => json!({ "intValue": value.to_string() }),
        Value::String(value) => json!({ "stringValue": value }),
        value => json!({ "stringValue": value.to_string() }),
    };
    json!({ "key": key, "value": encoded })
}

fn attrs(values: Vec<(&str, Value)>) -> Value {
    Value::Array(
        values
            .into_iter()
            .map(|(key, value)| attr(key, value))
            .collect(),
    )
}

fn span(
    trace_id: &str,
    span_id: &str,
    parent_id: Option<&str>,
    name: &str,
    started: u128,
    ended: u128,
    attributes: Value,
) -> Value {
    let mut value = json!({
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "startTimeUnixNano": started.to_string(),
        "endTimeUnixNano": ended.to_string(),
        "attributes": attributes,
        "status": { "code": 1 }
    });
    if let Some(parent_id) = parent_id {
        value["parentSpanId"] = json!(parent_id);
    }
    value
}

fn run_url(endpoint: &str, trace_id: &str) -> String {
    reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            url.host_str().map(|host| {
                let port = url
                    .port()
                    .map(|value| format!(":{value}"))
                    .unwrap_or_default();
                format!(
                    "{}://{}{}{}/{}",
                    url.scheme(),
                    host,
                    port,
                    "/runs",
                    trace_id
                )
            })
        })
        .unwrap_or_else(|| format!("http://localhost:5947/runs/{trace_id}"))
}

async fn index() -> Html<&'static str> {
    Html(PAGE)
}

async fn chat(
    State(state): State<AppState>,
    Json(input): Json<ChatInput>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let message = input.message.trim();
    if message.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "message is required" })),
        ));
    }
    let api_key = state.api_key.as_deref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "OPENAI_API_KEY is not configured" })),
        )
    })?;

    let trace_id = id(16);
    let root_id = id(8);
    let llm_id = id(8);
    let event_id = id(16);
    let messages = vec![Message {
        role: "user".into(),
        content: message.into(),
    }];
    let root_started = now_ns();
    let llm_started = now_ns();

    let response = state
        .client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&json!({ "model": state.model, "messages": messages }))
        .send()
        .await
        .map_err(|error| bad_gateway(error.to_string(), &state.otlp_endpoint, &trace_id))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| bad_gateway(error.to_string(), &state.otlp_endpoint, &trace_id))?;
    if !status.is_success() {
        return Err(bad_gateway(
            format!("OpenAI request failed ({status}): {body}"),
            &state.otlp_endpoint,
            &trace_id,
        ));
    }
    let result: OpenAiResponse = serde_json::from_str(&body)
        .map_err(|error| bad_gateway(error.to_string(), &state.otlp_endpoint, &trace_id))?;
    let output = result
        .choices
        .first()
        .map(|choice| choice.message.clone())
        .ok_or_else(|| {
            bad_gateway(
                "OpenAI response contained no choices".into(),
                &state.otlp_endpoint,
                &trace_id,
            )
        })?;
    let ended = now_ns();
    let input_json = serde_json::to_string(&messages).unwrap_or_default();
    let output_json = serde_json::to_string(&vec![output.clone()]).unwrap_or_default();
    let usage = result.usage.as_ref();

    let spans = vec![
        span(
            &trace_id,
            &root_id,
            None,
            "rust-openai-chat",
            root_started,
            ended,
            attrs(vec![
                ("runphantom.span.kind", json!("agent_root")),
                ("runphantom.event.id", json!(event_id)),
                ("runphantom.event.name", json!("rust-openai-chat")),
                ("runphantom.input", json!(input_json)),
                ("runphantom.output", json!(output_json)),
            ]),
        ),
        span(
            &trace_id,
            &llm_id,
            Some(&root_id),
            "openai.chat.completions",
            llm_started,
            ended,
            attrs(vec![
                ("runphantom.span.kind", json!("llm_call")),
                ("gen_ai.operation.name", json!("chat")),
                ("gen_ai.provider.name", json!("openai")),
                ("gen_ai.request.model", json!(result.model)),
                ("gen_ai.input.messages", json!(input_json)),
                ("gen_ai.output.messages", json!(output_json)),
                (
                    "gen_ai.usage.input_tokens",
                    json!(usage.map_or(0, |value| value.prompt_tokens)),
                ),
                (
                    "gen_ai.usage.output_tokens",
                    json!(usage.map_or(0, |value| value.completion_tokens)),
                ),
            ]),
        ),
    ];
    let payload = json!({
        "resourceSpans": [{
            "resource": { "attributes": [attr("service.name", json!("runphantom-examples"))] },
            "scopeSpans": [{
                "scope": { "name": "runphantom.examples", "version": "1.0.0" },
                "spans": spans
            }]
        }]
    });
    let export = state
        .client
        .post(&state.otlp_endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|error| bad_gateway(error.to_string(), &state.otlp_endpoint, &trace_id))?;
    if !export.status().is_success() {
        return Err(bad_gateway(
            format!("OTLP export failed ({})", export.status()),
            &state.otlp_endpoint,
            &trace_id,
        ));
    }

    Ok(Json(json!({
        "text": output.content,
        "runUrl": run_url(&state.otlp_endpoint, &trace_id)
    })))
}

fn bad_gateway(message: String, endpoint: &str, trace_id: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": message, "runUrl": run_url(endpoint, trace_id) })),
    )
}

#[tokio::main]
async fn main() {
    let port = env::var("PORT").unwrap_or_else(|_| "3018".into());
    let state = AppState {
        client: Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("HTTP client"),
        api_key: env::var("OPENAI_API_KEY")
            .ok()
            .filter(|value| !value.is_empty()),
        model: env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into()),
        otlp_endpoint: env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
            .unwrap_or_else(|_| "http://localhost:5947/v1/traces".into()),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/api/chat", post(chat))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .expect("bind example server");
    println!("Run Phantom Rust example: http://localhost:{port}");
    axum::serve(listener, app).await.expect("serve example");
}
