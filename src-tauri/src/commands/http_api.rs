use crate::error::AppError;
use crate::services::{deep_link, http_api};

/// Restart the embedded HTTP API server on a new port.
///
/// Called by the frontend when the user changes `extensionApiPort` in
/// Advanced settings and confirms the port-switch dialog.  The old server
/// is stopped before binding the new port.
#[tauri::command]
pub async fn restart_http_api(app: tauri::AppHandle, port: u16) -> Result<(), AppError> {
    http_api::restart_on_port(&app, port).await
}

/// Drain and return all pending deep-link URLs.
///
/// Called by the frontend during its boot sequence (`setupListeners` in
/// `useAppEvents.ts`) to consume deep-link URLs that were queued by native
/// external-input handlers while the WebView was being recreated.
///
/// Returns an empty vec if no URLs are pending (normal startup, or the
/// window was already alive when the download was routed).
#[tauri::command]
pub fn take_pending_deep_links(
    state: tauri::State<'_, deep_link::PendingDeepLinkState>,
) -> Vec<String> {
    deep_link::take_pending_deep_links(state.inner())
}
