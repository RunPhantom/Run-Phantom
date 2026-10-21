mod policy;
mod render;
#[cfg(target_os = "macos")] mod capture_macos;
use std::{io::{self, BufRead, Read, Write}, sync::Mutex, time::{Duration, Instant}};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use policy::{Policy, APPLICATION, WINDOW};
use render::{RenderGate, RenderTicket};

#[derive(Deserialize, Clone)]
struct Request {
    version: u8, application: String, window: String, nonce: String, id: String, generation: u64,
    #[serde(flatten)] operation: Operation,
}
#[derive(Deserialize, Clone)] #[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Operation { Observe, Action { action: String }, Capture { mode: String, consent: bool }, Cancel }
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
struct RenderAck { version: u8, id: String, generation: u64, value: i64, sequence: u64 }
fn emit_render(window: &tauri::WebviewWindow, ticket: &RenderTicket) -> Result<(), &'static str> {
    window.emit("fixture-state", json!({"version": 1, "id": ticket.id, "generation": ticket.generation, "value": ticket.value, "sequence": ticket.sequence})).map_err(|_| "unavailable")
}
#[tauri::command]
fn fixture_ready(window: tauri::WebviewWindow, render: tauri::State<RenderGate>) -> Result<(), &'static str> {
    if window.label() != WINDOW { return Err("denied"); }
    if let Some(ticket) = render.ready()? { emit_render(&window, &ticket)?; }
    Ok(())
}
#[tauri::command]
fn fixture_rendered(window: tauri::WebviewWindow, state: tauri::State<Mutex<Policy>>, render: tauri::State<RenderGate>, ack: RenderAck) -> Result<(), &'static str> {
    if window.label() != WINDOW || ack.version != 1 { return Err("denied"); }
    let ticket = RenderTicket { id: ack.id, generation: ack.generation, value: ack.value, sequence: ack.sequence };
    let p = state.lock().map_err(|_| "unavailable")?;
    if !ticket.matches_state(p.generation, p.value, p.sequence) { return Err("denied"); }
    render.acknowledge(&ticket)
}
#[tauri::command]
fn fixture_increment(window: tauri::WebviewWindow, state: tauri::State<Mutex<Policy>>) -> Result<i64, &'static str> {
    if window.label() != WINDOW { return Err("denied"); }
    let mut p = state.lock().map_err(|_| "unavailable")?; p.action("increment")?; Ok(p.value)
}
enum Prepared { Immediate(Value), Render { payload: Value, ticket: RenderTicket, capture: bool } }
fn prepare(app: &tauri::AppHandle, request: &Request, deadline: Instant) -> Result<Prepared, &'static str> {
        if request.version != 1 || request.id.len() != 36 { return Err("denied"); }
        let window = app.get_webview_window(WINDOW).ok_or("unavailable")?;
        if window.label() != request.window { return Err("denied"); }
        let state = app.state::<Mutex<Policy>>(); let mut p = state.lock().map_err(|_| "unavailable")?;
        if matches!(&request.operation, Operation::Cancel) {
            p.cancel(&request.application, &request.window, &request.nonce, request.generation)?;
            app.state::<RenderGate>().cancel()?;
            return Ok(Prepared::Immediate(json!({"cancelled": true})));
        }
        p.authorize(&request.application, &request.window, &request.nonce, request.generation)?;
        let (payload, capture) = match &request.operation {
            Operation::Capture { mode, consent } => {
                Policy::capture(mode, *consent)?;
                (json!({}), true)
            }
            Operation::Observe | Operation::Action { .. } => {
                if let Operation::Action { action } = &request.operation { p.action(action)?; }
                let observation = json!({"source": "cooperating-tauri", "value": p.value, "sequence": p.sequence});
                (json!({"observation": observation}), false)
            }
            Operation::Cancel => unreachable!(),
        };
        let ticket = RenderTicket { id: request.id.clone(), generation: p.generation, value: p.value, sequence: p.sequence };
        drop(p);
        let render = app.state::<RenderGate>();
        if Instant::now() >= deadline { return Err("unavailable"); }
        if render.begin(ticket.clone())? {
            if let Err(code) = emit_render(&window, &ticket) { render.abandon(&ticket)?; return Err(code); }
        }
        if Instant::now() >= deadline { render.abandon(&ticket)?; return Err("unavailable"); }
        Ok(Prepared::Render { payload, ticket, capture })
}
fn capture_rendered(app: &tauri::AppHandle, request: &Request, ticket: &RenderTicket) -> Result<Value, &'static str> {
    let window = app.get_webview_window(WINDOW).ok_or("unavailable")?;
    let state = app.state::<Mutex<Policy>>(); let p = state.lock().map_err(|_| "unavailable")?;
    p.authorize(&request.application, &request.window, &request.nonce, request.generation)?;
    if window.label() != request.window || ticket.id != request.id || !ticket.matches_state(p.generation, p.value, p.sequence) { return Err("cancelled"); }
    match &request.operation { Operation::Capture { mode, consent } => Policy::capture(mode, *consent)?, _ => return Err("denied") }
    #[cfg(target_os = "macos")] {
        let native = window.ns_window().map_err(|_| "unavailable")?;
        let png = unsafe { capture_macos::capture_owned_window(native)? };
        let hex: String = png.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(json!({"pngHex": hex}))
    }
    #[cfg(not(target_os = "macos"))] { Err("unavailable") }
}
fn on_main<T: Send + 'static>(app: &tauri::AppHandle, deadline: Instant, work: impl FnOnce(&tauri::AppHandle) -> Result<T, &'static str> + Send + 'static) -> Result<T, &'static str> {
    if Instant::now() >= deadline { return Err("unavailable"); }
    let dispatcher = app.clone(); let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = if Instant::now() < deadline { work(&dispatcher) } else { Err("unavailable") };
        let _ = send.send(result);
    }).map_err(|_| "unavailable")?;
    let remaining = deadline.checked_duration_since(Instant::now()).ok_or("unavailable")?;
    receive.recv_timeout(remaining).map_err(|_| "unavailable")?
}
fn dispatch(app: &tauri::AppHandle, request: Request) -> Value {
    let mut reply = json!({ "version": 1, "application": APPLICATION, "window": WINDOW, "nonce": request.nonce, "id": request.id, "generation": request.generation });
    // The original four-second native budget now covers readiness, acknowledgement AND capture.
    let deadline = Instant::now() + Duration::from_secs(4);
    let request_id = request.id.clone(); let generation = request.generation;
    let preparing = request.clone();
    let outcome = (|| -> Result<Value, &'static str> {
        match on_main(app, deadline, move |handle| prepare(handle, &preparing, deadline))? {
            Prepared::Immediate(payload) => Ok(payload),
            Prepared::Render { payload, ticket, capture } => {
                app.state::<RenderGate>().wait(&ticket, deadline)?;
                if !capture { return Ok(payload); }
                on_main(app, deadline, move |handle| capture_rendered(handle, &request, &ticket))
            }
        }
    })();
    if outcome.is_err() { let _ = app.state::<RenderGate>().abandon_request(&request_id, generation); }
    match outcome { Ok(payload) => { reply["status"] = json!("ok"); for (key, value) in payload.as_object().unwrap() { reply[key] = value.clone(); } }, Err(code) => reply["status"] = json!(code) }
    reply
}
fn main() {
    let policy = match std::env::var("RP_TAURI_FIXTURE_NONCE").ok().and_then(|n| Policy::new(n).ok()) { Some(p) => p, None => std::process::exit(78) };
    tauri::Builder::default().manage(Mutex::new(policy)).manage(RenderGate::default()).invoke_handler(tauri::generate_handler![fixture_increment, fixture_ready, fixture_rendered]).setup(|app| {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            let mut input = io::stdin().lock();
            loop {
                let mut line = Vec::new();
                // Requests are tiny; never retain unbounded input or print input/parser errors.
                if input.by_ref().take(4097).read_until(b'\n', &mut line).unwrap_or(0) == 0 { handle.exit(0); break; }
                if line.len() > 4096 || line.last() != Some(&b'\n') { handle.exit(78); break; }
                let object: Value = match serde_json::from_slice(&line) { Ok(v) => v, Err(_) => { handle.exit(78); break; } };
                let common = ["version", "application", "window", "nonce", "id", "generation", "kind"];
                let extras: &[&str] = match object["kind"].as_str() { Some("observe" | "cancel") => &[], Some("action") => &["action"], Some("capture") => &["mode", "consent"], _ => { handle.exit(78); break; } };
                if !object.as_object().map(|o| o.len() == common.len() + extras.len() && o.keys().all(|k| common.contains(&k.as_str()) || extras.contains(&k.as_str()))).unwrap_or(false) { handle.exit(78); break; }
                let request: Request = match serde_json::from_value(object) { Ok(r) => r, Err(_) => { handle.exit(78); break; } };
                let reply = dispatch(&handle, request);
                println!("RP_TAURI_V1 {reply}"); let _ = io::stdout().flush();
            }
        }); Ok(())
    }).run(tauri::generate_context!()).expect("Tauri fixture unavailable");
}
