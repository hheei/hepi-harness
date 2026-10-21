// Ticket 04 spike: minimal real Tauri v2 shell used only to observe platform behaviour.
// Throwaway by design — it is deleted once ticket 04's report is delivered.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::sync::Mutex;
use tauri::{Manager, State};

const KEYRING_SERVICE: &str = "dev.hepi.spike04";

struct Saves(Mutex<HashMap<u64, (File, u64)>>);
struct NextSave(Mutex<u64>);

#[tauri::command]
fn spike_env() -> serde_json::Value {
    serde_json::json!({
        "mode": std::env::var("SPIKE_MODE").unwrap_or_else(|_| "run".into()),
        "resultUrl": std::env::var("SPIKE_RESULT_URL").unwrap_or_default(),
        "mainOrigin": std::env::var("SPIKE_MAIN_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:18080".into()),
        "corsOrigin": std::env::var("SPIKE_CORS_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:18081".into()),
        "blockedOrigin": std::env::var("SPIKE_BLOCKED_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:18082".into()),
        "savePath": std::env::var("SPIKE_SAVE_PATH").unwrap_or_else(|_| "/tmp/hepi-spike-04-save.bin".into()),
        "userAgent": std::env::var("SPIKE_UA").unwrap_or_default(),
        // The live-ingress phase reads its origin and its device bearer from the environment the
        // harness generated, so no material is baked into the built asset.
        "ingressOrigin": std::env::var("SPIKE_INGRESS_ORIGIN").unwrap_or_default(),
        "ingressToken": std::env::var("SPIKE_INGRESS_TOKEN").unwrap_or_default(),
        "heavyConversation": std::env::var("SPIKE_INGRESS_HEAVY_CONVERSATION").unwrap_or_default(),
        "heavySentinel": std::env::var("SPIKE_INGRESS_HEAVY_SENTINEL").unwrap_or_default(),
    })
}

#[tauri::command]
fn store_credential(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| format!("{e:?}"))
}

#[tauri::command]
fn read_credential(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("{error:?}")),
    }
}

#[tauri::command]
fn delete_credential(key: String) -> Result<bool, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("{error:?}")),
    }
}

#[tauri::command]
fn spike_window(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    match action.as_str() {
        "hide" => window.hide().map_err(|e| e.to_string()),
        "show" => window.show().map_err(|e| e.to_string()),
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "restore" => window.unminimize().map_err(|e| e.to_string()),
        other => Err(format!("unknown action {other}")),
    }
}

#[tauri::command]
fn spike_done(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

/// Report a phase result on stdout so the harness can read the page's own observations
/// without a second network channel.
#[tauri::command]
fn spike_result(json: String) {
    use std::io::Write;
    // stdout is a pipe under the harness, so an unflushed line would be lost when the process
    // exits; the report has to be on the wire before that.
    let mut out = std::io::stdout();
    let _ = writeln!(out, "SPIKE_RESULT {}", json);
    let _ = out.flush();
}

#[tauri::command]
fn spike_mem() -> serde_json::Value {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| -> u64 {
        status
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    };
    serde_json::json!({
        "vmHwmKb": field("VmHWM:"),
        "vmRssKb": field("VmRSS:"),
    })
}

#[tauri::command]
fn begin_save(state: State<Saves>, next: State<NextSave>, path: String) -> Result<u64, String> {
    let mut id = next.0.lock().map_err(|e| e.to_string())?;
    *id += 1;
    let file = File::create(&path).map_err(|e| e.to_string())?;
    state.0.lock().map_err(|e| e.to_string())?.insert(*id, (file, 0));
    Ok(*id)
}

#[tauri::command]
fn append_save(state: State<Saves>, id: u64, chunk: Vec<u8>) -> Result<u64, String> {
    let mut saves = state.0.lock().map_err(|e| e.to_string())?;
    let (file, written) = saves.get_mut(&id).ok_or("unknown save id")?;
    file.write_all(&chunk).map_err(|e| e.to_string())?;
    *written += chunk.len() as u64;
    Ok(*written)
}

#[tauri::command]
fn finish_save(state: State<Saves>, id: u64) -> Result<u64, String> {
    let (mut file, written) = state.0.lock().map_err(|e| e.to_string())?.remove(&id).ok_or("unknown save id")?;
    file.flush().map_err(|e| e.to_string())?;
    Ok(written)
}

fn main() {
    tauri::Builder::default()
        .manage(Saves(Mutex::new(HashMap::new())))
        .manage(NextSave(Mutex::new(0)))
        .invoke_handler(tauri::generate_handler![
            spike_env,
            spike_window,
            spike_done,
            spike_result,
            spike_mem,
            store_credential,
            read_credential,
            delete_credential,
            begin_save,
            append_save,
            finish_save
        ])
        .run(tauri::generate_context!())
        .expect("tauri runtime error");
}
