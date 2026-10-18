mod policy;
#[cfg(target_os = "macos")] mod capture_macos;
use std::{io::{self, BufRead, Read, Write}, sync::Mutex};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use policy::{Policy, APPLICATION, WINDOW};

#[derive(Deserialize)]
struct Request {
    version: u8, application: String, window: String, nonce: String, id: String, generation: u64,
    #[serde(flatten)] operation: Operation,
}
#[derive(Deserialize)] #[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Operation { Observe, Action { action: String }, Capture { mode: String, consent: bool }, Cancel }
#[tauri::command]
fn fixture_increment(window: tauri::WebviewWindow, state: tauri::State<Mutex<Policy>>) -> Result<i64, &'static str> {
    if window.label() != WINDOW { return Err("denied"); }
    let mut p = state.lock().map_err(|_| "unavailable")?; p.action("increment")?; Ok(p.value)
}
fn dispatch(app: &tauri::AppHandle, request: Request) -> Value {
    let mut reply = json!({ "version": 1, "application": APPLICATION, "window": WINDOW, "nonce": request.nonce, "id": request.id, "generation": request.generation });
    let outcome = (|| -> Result<Value, &'static str> {
        if request.version != 1 || request.id.len() != 36 { return Err("denied"); }
        let window = app.get_webview_window(WINDOW).ok_or("unavailable")?;
        if window.label() != request.window { return Err("denied"); }
        let state = app.state::<Mutex<Policy>>(); let mut p = state.lock().map_err(|_| "unavailable")?;
        if matches!(request.operation, Operation::Cancel) {
            p.cancel(&request.application, &request.window, &request.nonce, request.generation)?;
            return Ok(json!({"cancelled": true}));
        }
        p.authorize(&request.application, &request.window, &request.nonce, request.generation)?;
        match request.operation {
            Operation::Capture { mode, consent } => {
                Policy::capture(&mode, consent)?;
                #[cfg(target_os = "macos")] {
                    let native = window.ns_window().map_err(|_| "unavailable")?;
                    let png = unsafe { capture_macos::capture_owned_window(native)? };
                    let hex: String = png.iter().map(|byte| format!("{byte:02x}")).collect();
                    Ok(json!({"pngHex": hex}))
                }
                #[cfg(not(target_os = "macos"))] { Err("unavailable") }
            }
            Operation::Observe | Operation::Action { .. } => {
                if let Operation::Action { action } = request.operation { p.action(&action)?; }
                let observation = json!({"source": "cooperating-tauri", "value": p.value, "sequence": p.sequence});
                window.emit("fixture-state", p.value).map_err(|_| "unavailable")?;
                Ok(json!({"observation": observation}))
            }
            Operation::Cancel => unreachable!(),
        }
    })();
    match outcome { Ok(payload) => { reply["status"] = json!("ok"); for (key, value) in payload.as_object().unwrap() { reply[key] = value.clone(); } }, Err(code) => reply["status"] = json!(code) }
    reply
}
fn main() {
    let policy = match std::env::var("RP_TAURI_FIXTURE_NONCE").ok().and_then(|n| Policy::new(n).ok()) { Some(p) => p, None => std::process::exit(78) };
    tauri::Builder::default().manage(Mutex::new(policy)).invoke_handler(tauri::generate_handler![fixture_increment]).setup(|app| {
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
                let dispatcher = handle.clone(); let (send, receive) = std::sync::mpsc::sync_channel(1);
                if handle.run_on_main_thread(move || { let _ = send.send(dispatch(&dispatcher, request)); }).is_err() { break; }
                match receive.recv_timeout(std::time::Duration::from_secs(4)) {
                    Ok(reply) => { println!("RP_TAURI_V1 {reply}"); let _ = io::stdout().flush(); }
                    Err(_) => { handle.exit(78); break; }
                }
            }
        }); Ok(())
    }).run(tauri::generate_context!()).expect("Tauri fixture unavailable");
}
