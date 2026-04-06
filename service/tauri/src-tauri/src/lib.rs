use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const PAN_SERVER: &str = "http://127.0.0.1:7777";
const SHELL_PORT: u16 = 7790;

// ==================== Window Registry ====================
#[derive(Debug, Clone, Serialize)]
struct WindowEntry {
    id: String,
    url: String,
    title: String,
    created_at: String,
}

type Registry = Arc<Mutex<HashMap<String, WindowEntry>>>;

static NEXT_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

fn new_window_id() -> String {
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("win-{}", id)
}

// ==================== Tauri Commands (callable from JS) ====================

#[tauri::command]
fn list_windows(registry: tauri::State<Registry>) -> Vec<WindowEntry> {
    let reg = registry.lock().unwrap();
    reg.values().cloned().collect()
}

#[tauri::command]
async fn open_window(
    app: AppHandle,
    registry: tauri::State<'_, Registry>,
    url: String,
    title: Option<String>,
) -> Result<String, String> {
    let win_id = new_window_id();
    let win_title = title.unwrap_or_else(|| "PAN".to_string());

    let window = WebviewWindowBuilder::new(&app, &win_id, WebviewUrl::External(url.parse().map_err(|e| format!("{}", e))?))
        .title(&win_title)
        .inner_size(1280.0, 800.0)
        .build()
        .map_err(|e| format!("{}", e))?;

    let _ = window.maximize();

    let entry = WindowEntry {
        id: win_id.clone(),
        url: url.clone(),
        title: win_title,
        created_at: chrono_now(),
    };
    registry.lock().unwrap().insert(win_id.clone(), entry);

    // Clean up on close
    let reg_clone = registry.inner().clone();
    let id_clone = win_id.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            reg_clone.lock().unwrap().remove(&id_clone);
        }
    });

    Ok(win_id)
}

#[tauri::command]
async fn screenshot_window(
    app: AppHandle,
    window_id: Option<String>,
) -> Result<String, String> {
    // If window_id given, screenshot that specific window
    // Otherwise screenshot the focused window or first available
    let target_label = window_id.unwrap_or_else(|| "main".to_string());

    if let Some(window) = app.get_webview_window(&target_label) {
        // Use xcap to capture the window's screen region
        let pos = window.outer_position().map_err(|e| format!("{}", e))?;
        let size = window.outer_size().map_err(|e| format!("{}", e))?;

        let monitors = xcap::Monitor::all().map_err(|e| format!("{}", e))?;
        // Find the monitor that contains this window
        let monitor = monitors.iter().find(|m| {
            let mx = m.x();
            let my = m.y();
            let mw = m.width() as i32;
            let mh = m.height() as i32;
            pos.x >= mx && pos.x < mx + mw && pos.y >= my && pos.y < my + mh
        }).or_else(|| monitors.first());
        if let Some(monitor) = monitor {
            let img = monitor.capture_image().map_err(|e| format!("{}", e))?;
            // Crop to window region relative to this monitor
            let crop_x = (pos.x - monitor.x()).max(0) as u32;
            let crop_y = (pos.y - monitor.y()).max(0) as u32;
            let crop_w = size.width.min(img.width().saturating_sub(crop_x));
            let crop_h = size.height.min(img.height().saturating_sub(crop_y));
            let cropped = image::imageops::crop_imm(
                &img,
                crop_x,
                crop_y,
                crop_w,
                crop_h,
            ).to_image();

            let mut buf = Cursor::new(Vec::new());
            cropped.write_to(&mut buf, image::ImageFormat::Png)
                .map_err(|e| format!("{}", e))?;

            let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
            Ok(b64)
        } else {
            Err("No monitors found".into())
        }
    } else {
        Err(format!("Window '{}' not found", target_label))
    }
}

#[tauri::command]
async fn screenshot_full() -> Result<String, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("{}", e))?;
    if let Some(monitor) = monitors.first() {
        let img = monitor.capture_image().map_err(|e| format!("{}", e))?;
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("{}", e))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
        Ok(b64)
    } else {
        Err("No monitors found".into())
    }
}

#[tauri::command]
async fn focus_window(app: AppHandle, window_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_id) {
        let _ = window.unminimize();
        let _ = window.show();
        window.set_focus().map_err(|e| format!("{}", e))?;
        Ok(())
    } else {
        Err(format!("Window '{}' not found", window_id))
    }
}

#[tauri::command]
async fn close_window(app: AppHandle, window_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_id) {
        window.close().map_err(|e| format!("{}", e))?;
        Ok(())
    } else {
        Err(format!("Window '{}' not found", window_id))
    }
}

// ==================== HTTP API (PAN server calls this directly) ====================

fn start_http_api(app_handle: AppHandle, registry: Registry) {
    std::thread::spawn(move || {
        let server = tiny_http::Server::http(format!("127.0.0.1:{}", SHELL_PORT))
            .expect("Failed to start shell HTTP server");
        println!("[PAN Shell] HTTP API listening on port {}", SHELL_PORT);

        for mut request in server.incoming_requests() {
            let url = request.url().to_string();
            let method = request.method().to_string();

            let (status, body) = match (method.as_str(), url.as_str()) {
                ("GET", "/ping") => {
                    (200, serde_json::json!({"ok": true, "shell": "tauri"}).to_string())
                }

                ("GET", "/windows") => {
                    let reg = registry.lock().unwrap();
                    let list: Vec<_> = reg.values().cloned().collect();
                    (200, serde_json::json!({"ok": true, "windows": list}).to_string())
                }

                ("POST", "/open") => {
                    let mut body_str = String::new();
                    let _ = request.as_reader().read_to_string(&mut body_str);
                    match serde_json::from_str::<serde_json::Value>(&body_str) {
                        Ok(val) => {
                            let url = val["url"].as_str().unwrap_or("http://127.0.0.1:7777").to_string();
                            let title = val["title"].as_str().map(|s| s.to_string());
                            let label = val["label"].as_str().map(|s| s.to_string());
                            let handle = app_handle.clone();
                            let reg = registry.clone();
                            // Use provided label or auto-generate
                            let win_id = label.unwrap_or_else(|| new_window_id());
                            let win_title = title.unwrap_or_else(|| "PAN".to_string());
                            let wid = win_id.clone();
                            let wtitle = win_title.clone();
                            let wurl = url.clone();
                            let handle2 = handle.clone();
                            handle.run_on_main_thread(move || {
                                if let Ok(window) = WebviewWindowBuilder::new(
                                    &handle2,
                                    &wid,
                                    WebviewUrl::External(wurl.parse().unwrap()),
                                )
                                .title(&wtitle)
                                .inner_size(1280.0, 800.0)
                                .build()
                                {
                                    let _ = window.maximize();
                                    let entry = WindowEntry {
                                        id: wid.clone(),
                                        url: wurl,
                                        title: wtitle,
                                        created_at: chrono_now(),
                                    };
                                    reg.lock().unwrap().insert(wid.clone(), entry);

                                    let reg2 = reg.clone();
                                    let id2 = wid.clone();
                                    window.on_window_event(move |event| {
                                        if let tauri::WindowEvent::Destroyed = event {
                                            reg2.lock().unwrap().remove(&id2);
                                        }
                                    });
                                }
                            }).ok();
                            (200, serde_json::json!({"ok": true, "windowId": win_id}).to_string())
                        }
                        Err(e) => (400, serde_json::json!({"ok": false, "error": e.to_string()}).to_string()),
                    }
                }

                ("POST", "/screenshot") => {
                    let mut body_str = String::new();
                    let _ = request.as_reader().read_to_string(&mut body_str);
                    let val = serde_json::from_str::<serde_json::Value>(&body_str).unwrap_or_default();
                    let window_id = val["windowId"].as_str().map(|s| s.to_string());

                    if let Some(wid) = window_id {
                        // Window-specific screenshot: find the window, find its monitor, crop
                        let handle = app_handle.clone();
                        let (tx, rx) = std::sync::mpsc::channel();
                        let handle2 = handle.clone();
                        let wid_for_closure = wid.clone();
                        handle.run_on_main_thread(move || {
                            if let Some(w) = handle2.get_webview_window(&wid_for_closure) {
                                let pos = w.outer_position().ok();
                                let size = w.outer_size().ok();
                                tx.send((pos, size)).ok();
                            } else {
                                tx.send((None, None)).ok();
                            }
                        }).ok();

                        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                            Ok((Some(pos), Some(size))) => {
                                match xcap::Monitor::all() {
                                    Ok(monitors) => {
                                        // Find which monitor contains this window
                                        let wx = pos.x;
                                        let wy = pos.y;
                                        let target_mon = monitors.iter().find(|m| {
                                            let mx = m.x();
                                            let my = m.y();
                                            let mw = m.width() as i32;
                                            let mh = m.height() as i32;
                                            wx >= mx && wx < mx + mw && wy >= my && wy < my + mh
                                        }).or_else(|| monitors.first());

                                        if let Some(monitor) = target_mon {
                                            match monitor.capture_image() {
                                                Ok(img) => {
                                                    // Crop to window position relative to this monitor
                                                    let crop_x = (wx - monitor.x()).max(0) as u32;
                                                    let crop_y = (wy - monitor.y()).max(0) as u32;
                                                    let crop_w = size.width.min(img.width().saturating_sub(crop_x));
                                                    let crop_h = size.height.min(img.height().saturating_sub(crop_y));
                                                    let cropped = image::imageops::crop_imm(&img, crop_x, crop_y, crop_w, crop_h).to_image();
                                                    let mut buf = Cursor::new(Vec::new());
                                                    if cropped.write_to(&mut buf, image::ImageFormat::Png).is_ok() {
                                                        let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
                                                        let path = std::env::temp_dir().join("pan-screenshot.png");
                                                        let _ = cropped.save(&path);
                                                        (200, serde_json::json!({
                                                            "ok": true, "base64": b64, "windowId": wid,
                                                            "path": path.to_string_lossy(),
                                                            "position": {"x": pos.x, "y": pos.y},
                                                            "size": {"w": size.width, "h": size.height}
                                                        }).to_string())
                                                    } else {
                                                        (500, serde_json::json!({"ok": false, "error": "encode failed"}).to_string())
                                                    }
                                                }
                                                Err(e) => (500, serde_json::json!({"ok": false, "error": e.to_string()}).to_string()),
                                            }
                                        } else {
                                            (500, serde_json::json!({"ok": false, "error": "no monitors"}).to_string())
                                        }
                                    }
                                    Err(e) => (500, serde_json::json!({"ok": false, "error": e.to_string()}).to_string()),
                                }
                            }
                            Ok(_) => (404, serde_json::json!({"ok": false, "error": format!("Window '{}' not found or has no position", wid)}).to_string()),
                            Err(_) => (500, serde_json::json!({"ok": false, "error": "Timeout getting window position"}).to_string()),
                        }
                    } else {
                        // Full screen screenshot (all monitors stitched or first)
                        match xcap::Monitor::all() {
                            Ok(monitors) => {
                                if let Some(monitor) = monitors.first() {
                                    match monitor.capture_image() {
                                        Ok(img) => {
                                            let mut buf = Cursor::new(Vec::new());
                                            if img.write_to(&mut buf, image::ImageFormat::Png).is_ok() {
                                                let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
                                                let path = std::env::temp_dir().join("pan-screenshot.png");
                                                let _ = img.save(&path);
                                                (200, serde_json::json!({
                                                    "ok": true, "base64": b64,
                                                    "path": path.to_string_lossy()
                                                }).to_string())
                                            } else {
                                                (500, serde_json::json!({"ok": false, "error": "encode failed"}).to_string())
                                            }
                                        }
                                        Err(e) => (500, serde_json::json!({"ok": false, "error": e.to_string()}).to_string()),
                                    }
                                } else {
                                    (500, serde_json::json!({"ok": false, "error": "no monitors"}).to_string())
                                }
                            }
                            Err(e) => (500, serde_json::json!({"ok": false, "error": e.to_string()}).to_string()),
                        }
                    }
                }

                ("POST", "/focus") => {
                    let mut body_str = String::new();
                    let _ = request.as_reader().read_to_string(&mut body_str);
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body_str) {
                        let wid = val["windowId"].as_str().unwrap_or("main").to_string();
                        let handle = app_handle.clone();
                        let handle2 = handle.clone();
                        handle.run_on_main_thread(move || {
                            if let Some(w) = handle2.get_webview_window(&wid) {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }).ok();
                        (200, serde_json::json!({"ok": true}).to_string())
                    } else {
                        (400, serde_json::json!({"ok": false, "error": "bad json"}).to_string())
                    }
                }

                ("POST", "/close") => {
                    let mut body_str = String::new();
                    let _ = request.as_reader().read_to_string(&mut body_str);
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body_str) {
                        let wid = val["windowId"].as_str().unwrap_or("").to_string();
                        let handle = app_handle.clone();
                        let handle2 = handle.clone();
                        let reg = registry.clone();
                        handle.run_on_main_thread(move || {
                            if let Some(w) = handle2.get_webview_window(&wid) {
                                let _ = w.close();
                                reg.lock().unwrap().remove(&wid);
                            }
                        }).ok();
                        (200, serde_json::json!({"ok": true}).to_string())
                    } else {
                        (400, serde_json::json!({"ok": false, "error": "bad json"}).to_string())
                    }
                }

                _ => (404, serde_json::json!({"error": "not found"}).to_string()),
            };

            let response = tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header(tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"application/json"[..],
                ).unwrap());
            let _ = request.respond(response);
        }
    });
}

// ==================== App Setup ====================

fn chrono_now() -> String {
    // Simple ISO timestamp without chrono dependency
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{}", now)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let win_h = Shortcut::new(Some(Modifiers::SUPER), Code::KeyH);
                    if shortcut == &win_h {
                        // Blur active element so webview releases keyboard focus
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("document.activeElement && document.activeElement.blur()");
                        }
                        // Unregister, send real Win+H to OS, re-register
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            let _ = handle.global_shortcut().unregister(win_h);
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            // Send real Win+H via Windows API
                            #[cfg(target_os = "windows")]
                            unsafe {
                                use std::mem::size_of;
                                #[repr(C)]
                                struct KeybdInput { r#type: u32, vk: u16, scan: u16, flags: u32, time: u32, extra: usize }
                                extern "system" { fn SendInput(count: u32, inputs: *const KeybdInput, size: i32) -> u32; }
                                let inputs = [
                                    KeybdInput { r#type: 1, vk: 0x5B, scan: 0, flags: 0, time: 0, extra: 0 }, // LWin down
                                    KeybdInput { r#type: 1, vk: 0x48, scan: 0, flags: 0, time: 0, extra: 0 }, // H down
                                    KeybdInput { r#type: 1, vk: 0x48, scan: 0, flags: 2, time: 0, extra: 0 }, // H up
                                    KeybdInput { r#type: 1, vk: 0x5B, scan: 0, flags: 2, time: 0, extra: 0 }, // LWin up
                                ];
                                SendInput(4, inputs.as_ptr(), size_of::<KeybdInput>() as i32);
                            }
                            std::thread::sleep(std::time::Duration::from_millis(200));
                            let _ = handle.global_shortcut().register(win_h);
                        });
                    }
                }
            })
            .build()
        )
        .manage(registry.clone())
        .invoke_handler(tauri::generate_handler![
            list_windows,
            open_window,
            screenshot_window,
            screenshot_full,
            focus_window,
            close_window,
        ])
        .setup(move |app| {
            // ---- System Tray ----
            let show_i = MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit PAN Shell", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .tooltip("PAN Shell")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ---- Register Win+H global shortcut to bypass WebView2 interception ----
            let win_h = Shortcut::new(Some(Modifiers::SUPER), Code::KeyH);
            app.global_shortcut().register(win_h)?;

            // ---- Start HTTP API so PAN server can call us directly ----
            let handle = app.handle().clone();
            start_http_api(handle, registry.clone());

            // ---- Register with PAN server ----
            let _handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::new();
                let _ = client.post(format!("{}/api/v1/register", PAN_SERVER))
                    .json(&serde_json::json!({
                        "name": "pan-shell",
                        "device_type": "desktop-shell",
                        "capabilities": ["windows", "screenshots", "tray"],
                        "shell_port": SHELL_PORT
                    }))
                    .send()
                    .await;
                println!("[PAN Shell] Registered with PAN server");
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PAN Shell");
}
