use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Deep-link URLs waiting for a recreated WebView to finish booting.
///
/// Lightweight mode destroys the main WebView when the user minimizes to tray.
/// External inputs must therefore survive the gap between native wake-up and
/// frontend listener registration.
pub struct PendingDeepLinkState(pub Mutex<Vec<String>>);

impl PendingDeepLinkState {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

/// Return only argv entries that represent external download inputs.
///
/// Used by the desktop single-instance callback. CLI flags are ignored; URL
/// schemes and supported local metadata/torrent files are forwarded.
pub fn filter_external_input_args(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|arg| {
            if arg.starts_with('-') {
                return false;
            }
            let lower = arg.to_lowercase();
            lower.contains("://")
                || lower.starts_with("magnet:")
                || lower.ends_with(".torrent")
                || lower.ends_with(".metalink")
                || lower.ends_with(".meta4")
        })
        .cloned()
        .collect()
}

/// Drain pending external inputs for the frontend boot path.
pub fn take_pending_deep_links(state: &PendingDeepLinkState) -> Vec<String> {
    match state.0.lock() {
        Ok(mut queue) => std::mem::take(&mut *queue),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    }
}

/// Route external inputs to the active frontend, or queue them before waking a
/// destroyed lightweight-mode window.
pub fn route_external_inputs(app: &AppHandle, urls: Vec<String>, source: &'static str) {
    if urls.is_empty() {
        log::debug!("deep_link:route source={source} count=0 skipped=true");
        return;
    }

    let window_was_alive = app.get_webview_window("main").is_some();
    log::info!(
        "deep_link:route source={source} count={} window_alive={window_was_alive}",
        urls.len()
    );

    if window_was_alive {
        wake_main_window(app, source);
        match app.emit("deep-link-open", &urls) {
            Ok(()) => return,
            Err(e) => {
                log::warn!("deep_link:emit-failed source={source} error={e}");
            }
        }
    }

    queue_pending_deep_links(app, &urls, source);
    schedule_main_window_wake(app, source);
}

fn queue_pending_deep_links(app: &AppHandle, urls: &[String], source: &'static str) {
    match app.try_state::<PendingDeepLinkState>() {
        Some(state) => match state.0.lock() {
            Ok(mut queue) => {
                queue.extend(urls.iter().cloned());
                log::info!(
                    "deep_link:queued source={source} count={} pending={}",
                    urls.len(),
                    queue.len()
                );
            }
            Err(poisoned) => {
                let mut queue = poisoned.into_inner();
                queue.extend(urls.iter().cloned());
                log::warn!(
                    "deep_link:queued-after-poison source={source} count={} pending={}",
                    urls.len(),
                    queue.len()
                );
            }
        },
        None => {
            log::error!(
                "deep_link:queue-unavailable source={source} count={}",
                urls.len()
            );
        }
    }
}

fn schedule_main_window_wake(app: &AppHandle, source: &'static str) {
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let app_for_main = app_for_task.clone();
        if let Err(e) = app_for_task.run_on_main_thread(move || {
            wake_main_window(&app_for_main, source);
        }) {
            log::error!("deep_link:wake-schedule-failed source={source} error={e}");
        }
    });
}

fn wake_main_window(app: &AppHandle, source: &'static str) {
    log::debug!("deep_link:wake-start source={source}");
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }

    if let Some(window) = crate::tray::get_or_create_main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        log::debug!("deep_link:wake-done source={source}");
    } else {
        log::error!("deep_link:wake-failed source={source}");
    }
}

#[cfg(test)]
mod tests {
    use super::filter_external_input_args;

    #[test]
    fn filters_supported_external_inputs_from_argv() {
        let args = vec![
            "/Applications/MotrixNext.app".to_string(),
            "--flag".to_string(),
            "file:///Users/example/ubuntu.torrent".to_string(),
            "/Users/example/Fedora.METALINK".to_string(),
            "magnet:?xt=urn:btih:abc".to_string(),
            "notes.txt".to_string(),
        ];

        let filtered = filter_external_input_args(&args);

        assert_eq!(
            filtered,
            vec![
                "file:///Users/example/ubuntu.torrent".to_string(),
                "/Users/example/Fedora.METALINK".to_string(),
                "magnet:?xt=urn:btih:abc".to_string()
            ]
        );
    }
}
