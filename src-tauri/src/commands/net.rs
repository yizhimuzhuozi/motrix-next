/// Fetches raw bytes from a remote HTTP/HTTPS URL.
///
/// Used by the frontend to download `.torrent` and `.metalink` files from
/// remote URLs when the user adds them via deep link from the browser
/// extension.  The frontend then base64-encodes the bytes and passes them
/// to aria2's `addTorrent` API so the torrent is properly parsed as a BT
/// task (instead of being downloaded as a regular file).
///
/// Uses the same `reqwest` crate already in use by the tracker prober,
/// with sensible defaults: 30s timeout, up to 5 redirects, TLS via rustls.
///
/// # Errors
///
/// Returns a human-readable error string on HTTP failure or network error.
/// The frontend falls back to displaying a generic load-failure message.
///
/// # Security
///
/// The URL is fully user-controlled (originates from a deep link the
/// extension constructed from the browser download URL).  A size limit
/// (16 MiB) prevents accidental memory exhaustion from malformed URLs.
use crate::error::AppError;

const MAX_TORRENT_SIZE: usize = 16 * 1024 * 1024; // 16 MiB — generous for any .torrent

#[tauri::command]
pub async fn fetch_remote_bytes(url: String) -> Result<Vec<u8>, AppError> {
    log::info!("fetch_remote_bytes: url={url:?}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| AppError::Io(format!("HTTP client init failed: {e}")))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("HTTP request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Io(format!("HTTP {}", resp.status())));
    }

    // Check Content-Length header upfront to reject oversized responses early
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_TORRENT_SIZE {
            return Err(AppError::Io(format!(
                "Response too large: {len} bytes (max {MAX_TORRENT_SIZE})"
            )));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Io(format!("Failed to read response body: {e}")))?;

    if bytes.len() > MAX_TORRENT_SIZE {
        return Err(AppError::Io(format!(
            "Response too large: {} bytes (max {MAX_TORRENT_SIZE})",
            bytes.len()
        )));
    }

    log::info!("fetch_remote_bytes: downloaded {} bytes", bytes.len());
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_torrent_size_is_16_mib() {
        assert_eq!(MAX_TORRENT_SIZE, 16 * 1024 * 1024);
    }
}
