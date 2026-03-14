use crate::engine;
use crate::error::AppError;
use crate::tray::TrayMenuState;
use serde_json::Value;
use tauri::window::ProgressBarState;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_store::StoreExt;

/// Reads all user preferences from the `user.json` store.
#[tauri::command]
pub fn get_app_config(app: AppHandle) -> Result<Value, AppError> {
    let store = app
        .store("user.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    let entries: serde_json::Map<String, Value> = store
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    Ok(Value::Object(entries))
}

/// Merges the given key-value pairs into the `user.json` store.
#[tauri::command]
pub fn save_preference(app: AppHandle, config: Value) -> Result<(), AppError> {
    let store = app
        .store("user.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            store.set(key.clone(), value.clone());
        }
    }
    Ok(())
}

/// Reads all system-level configuration from the `system.json` store.
#[tauri::command]
pub fn get_system_config(app: AppHandle) -> Result<Value, AppError> {
    let store = app
        .store("system.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    let entries: serde_json::Map<String, Value> = store
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    Ok(Value::Object(entries))
}

/// Merges the given key-value pairs into the `system.json` store.
#[tauri::command]
pub fn save_system_config(app: AppHandle, config: Value) -> Result<(), AppError> {
    let store = app
        .store("system.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            store.set(key.clone(), value.clone());
        }
    }
    Ok(())
}

/// Starts the aria2c engine process with current system configuration.
/// Runs on a background thread to avoid blocking the WebView main thread.
#[tauri::command]
pub async fn start_engine_command(app: AppHandle) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let config = get_system_config(app.clone())?;
        engine::start_engine(&app, &config).map_err(AppError::Engine)
    })
    .await
    .map_err(|e| AppError::Engine(e.to_string()))?
}

/// Gracefully stops the running aria2c engine process.
/// Runs on a background thread to avoid blocking the WebView main thread.
#[tauri::command]
pub async fn stop_engine_command(app: AppHandle) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || engine::stop_engine(&app).map_err(AppError::Engine))
        .await
        .map_err(|e| AppError::Engine(e.to_string()))?
}

/// Stops and restarts the aria2c engine with current system configuration.
/// Runs on a background thread to avoid blocking the WebView main thread
/// during the kill → sleep → cleanup → spawn sequence.
#[tauri::command]
pub async fn restart_engine_command(app: AppHandle) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let config = get_system_config(app.clone())?;
        engine::restart_engine(&app, &config).map_err(AppError::Engine)
    })
    .await
    .map_err(|e| AppError::Engine(e.to_string()))?
}

/// Clears user, system, and preference stores, resetting the app to defaults.
/// Also removes the aria2 session file to prevent tasks from resurrecting.
#[tauri::command]
pub fn factory_reset(app: AppHandle) -> Result<(), AppError> {
    let user_store = app
        .store("user.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    user_store.clear();
    let system_store = app
        .store("system.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    system_store.clear();
    // Also clear config.json where frontend preferences are persisted
    let config_store = app
        .store("config.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    config_store.clear();

    // Remove aria2 session file so downloads don't reappear after restart
    clear_session_file_inner(&app)?;

    Ok(())
}

/// Removes the aria2 download session file.
/// Called by both factory reset and session reset flows.
#[tauri::command]
pub fn clear_session_file(app: AppHandle) -> Result<(), AppError> {
    clear_session_file_inner(&app)
}

fn clear_session_file_inner(app: &AppHandle) -> Result<(), AppError> {
    let session_path = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join("download.session");
    if session_path.exists() {
        std::fs::remove_file(&session_path).map_err(|e| AppError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Updates the system tray title text (macOS menu bar display).
#[tauri::command]
pub fn update_tray_title(app: AppHandle, title: String) -> Result<(), AppError> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_title(Some(&title))
            .map_err(|e| AppError::Io(e.to_string()))?;
        // Workaround: re-set icon after set_title to prevent macOS icon disappearing (Tauri/tao bug)
        if let Some(icon) = app.default_window_icon() {
            let _ = tray.set_icon(Some(icon.clone()));
        }
    }
    Ok(())
}

/// Updates localized labels on tray menu items by their IDs.
#[tauri::command]
pub fn update_tray_menu_labels(app: AppHandle, labels: Value) -> Result<(), AppError> {
    let state = app.state::<TrayMenuState>();
    let items = state
        .items
        .lock()
        .map_err(|e| AppError::Store(e.to_string()))?;
    if let Some(obj) = labels.as_object() {
        for (id, text) in obj {
            if let Some(item) = items.get(id.as_str()) {
                let _ = item.set_text(text.as_str().unwrap_or(id));
            }
        }
    }
    Ok(())
}

/// Updates localized labels on application menu items by their IDs.
#[tauri::command]
pub fn update_menu_labels(app: AppHandle, labels: Value) -> Result<(), AppError> {
    use tauri::menu::MenuItemKind;
    if let Some(menu) = app.menu() {
        if let Some(obj) = labels.as_object() {
            for (id, text) in obj {
                if let Some(item) = menu.get(id) {
                    match item {
                        MenuItemKind::MenuItem(mi) => {
                            let _ = mi.set_text(text.as_str().unwrap_or(id));
                        }
                        MenuItemKind::Submenu(sub) => {
                            let _ = sub.set_text(text.as_str().unwrap_or(id));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(())
}

/// Updates the taskbar/dock progress bar (0.0–1.0 for progress, negative to clear).
#[tauri::command]
pub fn update_progress_bar(app: AppHandle, progress: f64) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window("main") {
        if progress < 0.0 {
            let _ = window.set_progress_bar(ProgressBarState {
                status: Some(tauri::window::ProgressBarStatus::None),
                progress: None,
            });
        } else {
            let _ = window.set_progress_bar(ProgressBarState {
                status: Some(tauri::window::ProgressBarStatus::Normal),
                progress: Some((progress * 100.0) as u64),
            });
        }
    }
    Ok(())
}

/// Updates the macOS dock badge label (empty string clears the badge).
#[tauri::command]
pub fn update_dock_badge(app: AppHandle, label: String) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_webview_window("main") {
            if label.is_empty() {
                let _ = window.set_badge_label(None::<String>);
            } else {
                let _ = window.set_badge_label(Some(label));
            }
        }
    }
    let _ = app; // suppress unused warning on non-macOS
    let _ = label;
    Ok(())
}

/// Toggles the macOS Dock icon visibility at runtime.
/// When `visible` is false, reads the `hideDockOnMinimize` preference from
/// the persistent store — only hides the Dock icon if the user opted in.
/// When `visible` is true, always restores the icon (e.g. on Reopen / tray show).
/// No-op on non-macOS platforms.
#[tauri::command]
pub fn set_dock_visible(app: AppHandle, visible: bool) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        use tauri_plugin_store::StoreExt;

        if visible {
            let _ = app.set_activation_policy(ActivationPolicy::Regular);
        } else {
            let hide_dock = app
                .store("config.json")
                .ok()
                .and_then(|s| s.get("preferences"))
                .and_then(|p| p.get("hideDockOnMinimize")?.as_bool())
                .unwrap_or(false);
            if hide_dock {
                let _ = app.set_activation_policy(ActivationPolicy::Accessory);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
    Ok(())
}

/// Probes a list of tracker URLs for reachability via HTTP HEAD requests.
/// UDP and WSS trackers cannot be probed from HTTP and are marked `"unknown"`.
/// Returns a JSON map of `{ url: "online" | "offline" | "unknown" }`.
#[tauri::command]
pub async fn probe_trackers(urls: Vec<String>) -> Result<Value, AppError> {
    use std::collections::HashMap;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| AppError::Io(e.to_string()))?;

    let mut results: HashMap<String, String> = HashMap::new();

    for url in &urls {
        if url.starts_with("udp://") || url.starts_with("wss://") {
            results.insert(url.clone(), "unknown".to_string());
            continue;
        }
        let status = match client.head(url).send().await {
            Ok(_) => "online",
            Err(_) => "offline",
        };
        results.insert(url.clone(), status.to_string());
    }

    serde_json::to_value(results).map_err(|e| AppError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_probe_classifies_udp_as_unknown() {
        let urls = vec!["udp://tracker.example.com:6969".to_string()];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(probe_trackers(urls)).unwrap();
        let map = result.as_object().unwrap();
        assert_eq!(
            map.get("udp://tracker.example.com:6969")
                .unwrap()
                .as_str()
                .unwrap(),
            "unknown"
        );
    }

    #[test]
    fn test_probe_classifies_wss_as_unknown() {
        let urls = vec!["wss://tracker.example.com/announce".to_string()];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(probe_trackers(urls)).unwrap();
        let map = result.as_object().unwrap();
        assert_eq!(
            map.get("wss://tracker.example.com/announce")
                .unwrap()
                .as_str()
                .unwrap(),
            "unknown"
        );
    }

    #[test]
    fn test_probe_empty_list_returns_empty() {
        let urls: Vec<String> = vec![];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(probe_trackers(urls)).unwrap();
        let map = result.as_object().unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn test_probe_unreachable_http_returns_offline() {
        // Use an invalid host that will fail to connect within the timeout
        let urls = vec!["http://192.0.2.1:1/announce".to_string()];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(probe_trackers(urls)).unwrap();
        let map = result.as_object().unwrap();
        assert_eq!(
            map.get("http://192.0.2.1:1/announce")
                .unwrap()
                .as_str()
                .unwrap(),
            "offline"
        );
    }
}

/// Returns `true` when the current process was launched by the OS
/// autostart mechanism (the Tauri autostart plugin appends `--autostart`).
#[tauri::command]
pub fn is_autostart_launch() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

/// Collects all log files from the app log directory and compresses them
/// into a ZIP archive at the user-specified path (chosen via a save dialog
/// on the frontend). Includes a `system-info.json` with OS, architecture,
/// and app version for diagnostic context.
/// Returns the full path to the created ZIP file.
#[tauri::command]
pub async fn export_diagnostic_logs(app: AppHandle, save_path: String) -> Result<String, AppError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;

    if !log_dir.exists() {
        return Err(AppError::NotFound("Log directory does not exist".into()));
    }

    let zip_path = std::path::PathBuf::from(&save_path);

    let zip_file = std::fs::File::create(&zip_path)
        .map_err(|e| AppError::Io(format!("Failed to create zip: {}", e)))?;
    let mut zip_writer = zip::ZipWriter::new(zip_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // ── System info: embed machine context for diagnostics ──────────
    let pkg = app.package_info();
    let system_info = serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "app_version": pkg.version.to_string(),
        "app_name": pkg.name,
        "exported_at": chrono::Local::now().to_rfc3339(),
    });
    let info_bytes = serde_json::to_vec_pretty(&system_info)
        .map_err(|e| AppError::Io(format!("Failed to serialize system info: {}", e)))?;
    zip_writer
        .start_file("system-info.json", options)
        .map_err(|e| AppError::Io(format!("Failed to add system-info.json: {}", e)))?;
    std::io::Write::write_all(&mut zip_writer, &info_bytes)
        .map_err(|e| AppError::Io(format!("Failed to write system-info.json: {}", e)))?;

    // ── Log files ───────────────────────────────────────────────────
    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| AppError::Io(format!("Failed to read log dir: {}", e)))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let content = std::fs::read(&path)
                .map_err(|e| AppError::Io(format!("Failed to read {}: {}", name, e)))?;
            zip_writer
                .start_file(name.to_string(), options)
                .map_err(|e| AppError::Io(format!("Failed to add {} to zip: {}", name, e)))?;
            std::io::Write::write_all(&mut zip_writer, &content)
                .map_err(|e| AppError::Io(format!("Failed to write {}: {}", name, e)))?;
        }
    }

    zip_writer
        .finish()
        .map_err(|e| AppError::Io(format!("Failed to finalize zip: {}", e)))?;

    log::info!("Exported diagnostic logs to {}", zip_path.display());
    Ok(zip_path.to_string_lossy().to_string())
}
