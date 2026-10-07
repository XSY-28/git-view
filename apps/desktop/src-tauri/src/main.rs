#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
mod config;
mod sidecar;
#[cfg(windows)]
mod windows_platform;

use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct InitialOpen {
    path: Option<String>,
    ready: bool,
}
struct Host {
    sidecar: sidecar::Sidecar,
    initial_repository: Mutex<InitialOpen>,
    picking: AtomicBool,
}

fn parse_open(args: &[String]) -> Result<Option<String>, String> {
    if args.is_empty() {
        return Ok(None);
    }
    if args[0] != "open" {
        return Err("Use open|inspect --repo <absolute-path> [--json]".into());
    }
    let mut repository = None;
    let mut view_seen = false;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => {}
            "--repo" if repository.is_none() => {
                index += 1;
                let path = args.get(index).ok_or("Missing --repo path")?;
                if !PathBuf::from(path).is_absolute() || path.contains('\0') {
                    return Err("Repository path must be absolute".into());
                }
                repository = Some(path.clone());
            }
            "--view" if !view_seen => {
                index += 1;
                if args.get(index).map(String::as_str) != Some("changes") {
                    return Err("Only --view changes is supported".into());
                }
                view_seen = true;
            }
            _ => return Err("Unknown or duplicate argument".into()),
        }
        index += 1;
    }
    repository.map(Some).ok_or("Missing --repo".into())
}

#[tauri::command]
fn initial_repository(host: tauri::State<'_, Host>) -> Option<String> {
    let mut initial = host.initial_repository.lock().unwrap();
    initial.ready = true;
    initial.path.take()
}

#[tauri::command]
async fn query(
    app: tauri::AppHandle,
    host: tauri::State<'_, Host>,
    message: Value,
) -> Result<Value, String> {
    if message.get("operation").and_then(Value::as_str) == Some("request")
        && message.pointer("/request/action").and_then(Value::as_str) == Some("pick-folder")
    {
        let envelope = message.as_object().ok_or("Invalid picker envelope")?;
        let request = message
            .get("request")
            .and_then(Value::as_object)
            .ok_or("Invalid picker request")?;
        let valid_id = |value: Option<&Value>, max| {
            value
                .and_then(Value::as_str)
                .map(|id| !id.is_empty() && id.chars().count() <= max)
                .unwrap_or(false)
        };
        if envelope.len() != 3
            || request.len() != 3
            || !valid_id(envelope.get("id"), config::MAX_ENVELOPE_ID_CHARS)
            || !valid_id(request.get("requestId"), 100)
            || request.get("schemaVersion").and_then(Value::as_u64)
                != Some(config::PROTOCOL_VERSION)
        {
            return Err("Invalid picker request".into());
        }
        if host.picking.swap(true, Ordering::SeqCst) {
            return Err("Folder picker is already open".into());
        }
        let picked = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("选择 Git 仓库目录")
                .blocking_pick_folder()
        })
        .await;
        host.picking.store(false, Ordering::SeqCst);
        let path = picked.map_err(|_| "Folder picker failed")?;
        let choice = match path {
            Some(path) => {
                let path = path.into_path().map_err(|_| "Invalid selected folder")?;
                let path = path.to_str().ok_or("Selected folder path is not UTF-8")?;
                json!({"cancelled": false, "path": path})
            }
            None => json!({"cancelled":true}),
        };
        return Ok(json!({"schemaVersion": config::PROTOCOL_VERSION, "ok": true, "data": choice}));
    }
    host.sidecar.query(message).await
}

fn main() {
    // The native single-instance socket and future private state belong to this user.
    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(windows)]
    if args.as_slice() == ["--windows-platform"] {
        windows_platform::main();
        return;
    }
    if args.first().map(String::as_str) == Some("inspect") {
        // This branch exits before any Tauri builder, webview or dialog is created.
        let status = config::cli_resources().and_then(|resources| {
            let (node, entry) = config::runtime_files(&resources, "inspect.mjs");
            std::process::Command::new(node)
                .arg(entry)
                .args(&args)
                .status()
        });
        match status {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(_) => {
                println!(
                    "{}",
                    json!({"schemaVersion":1,"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Bundled inspector could not start","retryable":true}})
                );
                std::process::exit(1);
            }
        }
    }
    let repository = match parse_open(&args) {
        Ok(path) => path,
        Err(message) => {
            println!(
                "{}",
                json!({"schemaVersion":1,"ok":false,"error":{"code":"INVALID_REQUEST","message":message,"retryable":false}})
            );
            std::process::exit(1);
        }
    };
    if repository.is_some() && std::env::var_os("GIT_VIEW_DESKTOP_GUI").is_none() {
        let launch = std::env::current_exe().and_then(|executable| {
            let mut command = std::process::Command::new(executable);
            command
                .args(&args)
                .env("GIT_VIEW_DESKTOP_GUI", "1")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x00000008 | 0x00000200);
            }
            command.spawn()
        });
        match launch {
            Ok(_) => println!(
                "{}",
                json!({"schemaVersion":1,"ok":true,"action":"open","launchStatus":"requested","rendered":"unverified"})
            ),
            Err(_) => {
                println!(
                    "{}",
                    json!({"schemaVersion":1,"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Desktop process could not start","retryable":true}})
                );
                std::process::exit(1);
            }
        }
        return;
    }
    let resources = config::cli_resources().expect("Bundled runtime resources are missing");
    let app = tauri::Builder::default()
        .manage(Host {
            sidecar: sidecar::Sidecar::new(resources),
            initial_repository: Mutex::new(InitialOpen {
                path: repository,
                ready: false,
            }),
            picking: AtomicBool::new(false),
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Ok(Some(path)) = parse_open(&args.into_iter().skip(1).collect::<Vec<_>>()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let host = app.state::<Host>();
                let mut initial = host.initial_repository.lock().unwrap();
                if initial.ready {
                    let _ = app.emit("open-repository", json!({"path":path}));
                } else {
                    initial.path = Some(path);
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![query, initial_repository])
        .build(tauri::generate_context!())
        .expect("Desktop initialization failed");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Host>().sidecar.stop();
        }
    });
}
