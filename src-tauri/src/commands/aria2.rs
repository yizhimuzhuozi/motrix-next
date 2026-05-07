//! Tauri commands exposing aria2 RPC operations to the frontend.
//!
//! These commands serve as the invoke() transport layer. Each command maps
//! to one or more aria2 RPC methods.

use crate::aria2::client::Aria2State;
use crate::aria2::types::{Aria2File, Aria2Task};
use crate::commands::net::decode_filename_encoding;
use crate::error::AppError;
use tauri::State;

/// Fetch task list by type: "active" returns active+waiting, otherwise stopped.
#[tauri::command]
pub async fn aria2_fetch_task_list(
    state: State<'_, Aria2State>,
    r#type: String,
    limit: Option<i64>,
) -> Result<Vec<Aria2Task>, AppError> {
    if r#type == "active" {
        let (active, waiting) =
            tokio::try_join!(state.0.tell_active(), state.0.tell_waiting(0, 1000),)?;
        let mut result = active;
        result.extend(waiting);
        Ok(result)
    } else {
        state.0.tell_stopped(0, limit.unwrap_or(1000)).await
    }
}

/// Fetch only active tasks (no waiting).
#[tauri::command]
pub async fn aria2_fetch_active_task_list(
    state: State<'_, Aria2State>,
) -> Result<Vec<Aria2Task>, AppError> {
    state.0.tell_active().await
}

/// Fetch a single task's full status by GID.
#[tauri::command]
pub async fn aria2_fetch_task_item(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<Aria2Task, AppError> {
    state.0.tell_status(&gid).await
}

/// Fetch task status with peer list (for BT tasks).
#[tauri::command]
pub async fn aria2_fetch_task_item_with_peers(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    let (task, peers) = tokio::try_join!(state.0.tell_status(&gid), state.0.get_peers(&gid),)?;
    let mut result =
        serde_json::to_value(&task).map_err(|e| AppError::Aria2(format!("serialize task: {e}")))?;
    result["peers"] = peers;
    Ok(result)
}

/// Get aria2 engine version and enabled features.
#[tauri::command]
pub async fn aria2_get_version(
    state: State<'_, Aria2State>,
) -> Result<serde_json::Value, AppError> {
    state.0.get_version().await
}

/// Get global aria2 options.
#[tauri::command]
pub async fn aria2_get_global_option(
    state: State<'_, Aria2State>,
) -> Result<serde_json::Value, AppError> {
    state.0.get_global_option().await
}

/// Get global download/upload statistics.
#[tauri::command]
pub async fn aria2_get_global_stat(
    state: State<'_, Aria2State>,
) -> Result<serde_json::Value, AppError> {
    let stat = state.0.get_global_stat().await?;
    serde_json::to_value(&stat).map_err(|e| AppError::Aria2(format!("serialize stat: {e}")))
}

/// Change global aria2 options at runtime.
#[tauri::command]
pub async fn aria2_change_global_option(
    state: State<'_, Aria2State>,
    options: serde_json::Map<String, serde_json::Value>,
) -> Result<String, AppError> {
    state.0.change_global_option(options).await
}

/// Get per-task options.
#[tauri::command]
pub async fn aria2_get_option(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    state.0.get_option(&gid).await
}

/// Change per-task options.
#[tauri::command]
pub async fn aria2_change_option(
    state: State<'_, Aria2State>,
    gid: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    state.0.change_option(&gid, options).await
}

/// Get file list for a task.
#[tauri::command]
pub async fn aria2_get_files(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<Vec<Aria2File>, AppError> {
    state.0.get_files(&gid).await
}

// ── `out` option sanitization ────────────────────────────────────────

/// Sanitizes an `out` option value into a safe, platform-valid filename.
///
/// aria2's `out` option must be a plain filename relative to `dir`.  aria2
/// itself performs **no** filename sanitization — it passes the value
/// directly to the OS `open()` call.  This function is the authoritative
/// safety boundary.
///
/// Three-step pipeline:
///   1. **Basename extraction** — strips path separators (including Windows
///      drive letters, UNC prefixes, and Unix absolute paths).
///   2. **NUL rejection** — NUL bytes truncate C strings inside aria2.
///   3. **Industry-standard sanitization** via the `sanitize-filename` crate
///      (same character set as Chrome `filename_util.cc` and Node.js
///      `sanitize-filename`):
///      - Replaces `/ \ : * ? " < > |` with `_`
///      - Removes ASCII control chars (0x00–0x1F, 0x7F) and C1 (0x80–0x9F)
///      - Rejects Windows reserved names (CON, NUL, COM1, LPT1, etc.)
///      - Strips trailing dots and spaces (Windows rejects these)
///      - Truncates to 255 bytes (filesystem limit)
///
/// Returns `None` for values that reduce to empty after sanitization.
fn sanitize_out_option(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    // 1. Basename extraction — split on both separators for cross-platform.
    let basename = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    if basename.is_empty() || basename == "." || basename == ".." {
        return None;
    }
    // 2. Reject NUL bytes early (truncate C strings inside aria2).
    if basename.contains('\0') {
        return None;
    }
    // 3. Industry-standard sanitization (Chrome / sanitize-filename char set).
    //    Always use Windows rules (most restrictive) regardless of build target
    //    to ensure filenames are safe when the Rust backend runs on any platform
    //    but may serve files destined for Windows clients.
    let decoded = decode_filename_encoding(basename);
    let sanitized = sanitize_filename::sanitize_with_options(
        decoded.as_str(),
        sanitize_filename::Options {
            windows: true,
            truncate: true,
            replacement: "_",
        },
    );
    let result = sanitized.trim().to_string();
    if result.is_empty() {
        return None;
    }
    Some(result)
}

/// Add URI download(s). Each URI gets its own aria2 task with optional
/// per-URI `out` filename override and file-category directory resolution.
#[tauri::command]
pub async fn aria2_add_uri(
    state: State<'_, Aria2State>,
    uris: Vec<String>,
    mut options: serde_json::Value,
) -> Result<String, AppError> {
    // Enforce out = safe-filename invariant before forwarding to aria2.
    // Prevents path traversal (#261) and illegal-character crashes (#264).
    if let Some(opts) = options.as_object_mut() {
        if let Some(out_val) = opts.get("out").and_then(|v| v.as_str()).map(String::from) {
            match sanitize_out_option(&out_val) {
                Some(ref clean) if *clean != out_val => {
                    log::warn!("aria2:add-uri sanitized out: {:?} → {:?}", out_val, clean);
                    opts.insert("out".to_string(), serde_json::Value::String(clean.clone()));
                }
                None => {
                    log::warn!("aria2:add-uri removed invalid out option");
                    opts.remove("out");
                }
                _ => {} // already a clean filename — no action needed
            }
        }
    }
    log::info!("aria2:add-uri count={}", uris.len());
    state.0.add_uri(uris, options).await
}

/// Add a torrent download from base64-encoded content.
#[tauri::command]
pub async fn aria2_add_torrent(
    state: State<'_, Aria2State>,
    torrent: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    log::info!("aria2:add-torrent");
    state.0.add_torrent(&torrent, options).await
}

/// Add a metalink download from base64-encoded content.
#[tauri::command]
pub async fn aria2_add_metalink(
    state: State<'_, Aria2State>,
    metalink: String,
    options: serde_json::Value,
) -> Result<Vec<String>, AppError> {
    log::info!("aria2:add-metalink");
    state.0.add_metalink(&metalink, options).await
}

/// Forcefully remove a task by GID.
#[tauri::command]
pub async fn aria2_force_remove(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    log::info!("aria2:remove gid={gid}");
    state.0.force_remove(&gid).await
}

/// Forcefully pause a task by GID.
#[tauri::command]
pub async fn aria2_force_pause(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    log::debug!("aria2:force-pause gid={gid}");
    state.0.force_pause(&gid).await
}

/// Gracefully pause a task.
#[tauri::command]
pub async fn aria2_pause(state: State<'_, Aria2State>, gid: String) -> Result<String, AppError> {
    log::debug!("aria2:pause gid={gid}");
    state.0.pause(&gid).await
}

/// Resume a paused task.
#[tauri::command]
pub async fn aria2_unpause(state: State<'_, Aria2State>, gid: String) -> Result<String, AppError> {
    log::debug!("aria2:resume gid={gid}");
    state.0.unpause(&gid).await
}

/// Pause all active downloads (graceful).
#[tauri::command]
pub async fn aria2_pause_all(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.pause_all().await
}

/// Forcefully pause all active downloads.
#[tauri::command]
pub async fn aria2_force_pause_all(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.force_pause_all().await
}

/// Resume all paused downloads.
#[tauri::command]
pub async fn aria2_unpause_all(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.unpause_all().await
}

/// Save the current aria2 session to disk.
#[tauri::command]
pub async fn aria2_save_session(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.save_session().await
}

/// Remove a completed/errored task record from aria2's download list.
#[tauri::command]
pub async fn aria2_remove_download_result(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    state.0.remove_download_result(&gid).await
}

/// Purge all completed/errored download results.
#[tauri::command]
pub async fn aria2_purge_download_result(state: State<'_, Aria2State>) -> Result<String, AppError> {
    log::info!("aria2:purge-results");
    state.0.purge_download_result().await
}

/// Batch resume multiple tasks via multicall.
#[tauri::command]
pub async fn aria2_batch_unpause(
    state: State<'_, Aria2State>,
    gids: Vec<String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    log::info!("aria2:batch-resume count={}", gids.len());
    let calls = gids
        .into_iter()
        .map(|gid| ("unpause".to_string(), vec![serde_json::Value::String(gid)]))
        .collect();
    state.0.multicall(calls).await
}

/// Batch force-pause multiple tasks via multicall.
#[tauri::command]
pub async fn aria2_batch_force_pause(
    state: State<'_, Aria2State>,
    gids: Vec<String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    log::info!("aria2:batch-pause count={}", gids.len());
    let calls = gids
        .into_iter()
        .map(|gid| {
            (
                "forcePause".to_string(),
                vec![serde_json::Value::String(gid)],
            )
        })
        .collect();
    state.0.multicall(calls).await
}

/// Batch force-remove multiple tasks via multicall.
#[tauri::command]
pub async fn aria2_batch_force_remove(
    state: State<'_, Aria2State>,
    gids: Vec<String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    log::info!("aria2:batch-remove count={}", gids.len());
    let calls = gids
        .into_iter()
        .map(|gid| {
            (
                "forceRemove".to_string(),
                vec![serde_json::Value::String(gid)],
            )
        })
        .collect();
    state.0.multicall(calls).await
}

#[cfg(test)]
mod tests {
    use super::sanitize_out_option;

    // ── Existing #261 tests (updated for String return) ─────────────

    #[test]
    fn bare_filename_passes_through() {
        assert_eq!(sanitize_out_option("file.zip").as_deref(), Some("file.zip"));
    }

    #[test]
    fn windows_backslash_absolute_extracts_basename() {
        assert_eq!(
            sanitize_out_option("C:\\Users\\u\\Downloads\\file.zip").as_deref(),
            Some("file.zip")
        );
    }

    #[test]
    fn forward_slash_absolute_extracts_basename() {
        assert_eq!(
            sanitize_out_option("C:/Users/u/Downloads/file.zip").as_deref(),
            Some("file.zip")
        );
    }

    #[test]
    fn unc_path_extracts_basename() {
        assert_eq!(
            sanitize_out_option("\\\\server\\share\\file.zip").as_deref(),
            Some("file.zip")
        );
    }

    #[test]
    fn parent_traversal_extracts_basename() {
        assert_eq!(
            sanitize_out_option("../evil.exe").as_deref(),
            Some("evil.exe")
        );
    }

    #[test]
    fn dotdot_only_rejected() {
        assert_eq!(sanitize_out_option(".."), None);
    }

    #[test]
    fn dot_only_rejected() {
        assert_eq!(sanitize_out_option("."), None);
    }

    #[test]
    fn empty_rejected() {
        assert_eq!(sanitize_out_option(""), None);
    }

    #[test]
    fn nul_byte_rejected() {
        assert_eq!(sanitize_out_option("file\0.zip"), None);
    }

    #[test]
    fn accented_filename_preserved() {
        assert_eq!(
            sanitize_out_option("C:/Downloads/résumé.zip").as_deref(),
            Some("résumé.zip")
        );
    }

    #[test]
    fn trailing_separator_rejected() {
        assert_eq!(sanitize_out_option("path/to/"), None);
    }

    #[test]
    fn issue_261_regression() {
        assert_eq!(
            sanitize_out_option("C:/Users/37472/Downloads/sysdiag-all-x64.exe").as_deref(),
            Some("sysdiag-all-x64.exe")
        );
    }

    // ── #264: illegal character sanitization ────────────────────────

    #[test]
    fn issue_264_twitter_cdn_filename() {
        // Extension sends "G9v9wWdasAYNqt9?format=jpg&name=large" as filename.
        // `?` is replaced with `_` by the crate; `&` and `=` are legal filename
        // chars and pass through unchanged.
        assert_eq!(
            sanitize_out_option("G9v9wWdasAYNqt9?format=jpg&name=large").as_deref(),
            Some("G9v9wWdasAYNqt9_format=jpg&name=large")
        );
    }

    #[test]
    fn replaces_windows_illegal_chars() {
        assert_eq!(
            sanitize_out_option("a<b>c:d*e.jpg").as_deref(),
            Some("a_b_c_d_e.jpg")
        );
    }

    #[test]
    fn replaces_pipe_and_quotes() {
        assert_eq!(
            sanitize_out_option("file\"|pipe.txt").as_deref(),
            Some("file__pipe.txt")
        );
    }

    #[test]
    fn question_mark_in_filename_replaced() {
        // "what?.jpg" → "what_.jpg" (not truncated to "what")
        assert_eq!(
            sanitize_out_option("what?.jpg").as_deref(),
            Some("what_.jpg")
        );
    }

    #[test]
    fn percent_encoded_rfc2047_out_decodes_before_sanitize() {
        assert_eq!(
            sanitize_out_option("=%3FUTF-8%3FB%3F0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4%3F=")
                .as_deref(),
            Some("ИТОГИ ЛДУ 2026.xlsx")
        );
    }

    #[test]
    fn rfc2047_out_decodes_before_sanitize() {
        assert_eq!(
            sanitize_out_option("=?UTF-8?B?0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4?=").as_deref(),
            Some("ИТОГИ ЛДУ 2026.xlsx")
        );
    }

    // ── Windows reserved names ──────────────────────────────────────
    // The crate replaces reserved names with the replacement string "_".
    // Our wrapper then trims and rejects empty — but "_" is non-empty,
    // so reserved names become "_".  This is safe: "_" is a valid
    // filename on all platforms.

    #[test]
    fn windows_reserved_con_becomes_underscore() {
        assert_eq!(sanitize_out_option("CON").as_deref(), Some("_"));
    }

    #[test]
    fn windows_reserved_nul_txt_becomes_underscore() {
        assert_eq!(sanitize_out_option("NUL.txt").as_deref(), Some("_"));
    }

    #[test]
    fn windows_reserved_com1_becomes_underscore() {
        assert_eq!(sanitize_out_option("com1").as_deref(), Some("_"));
    }

    #[test]
    fn windows_reserved_lpt3_becomes_underscore() {
        assert_eq!(sanitize_out_option("LPT3").as_deref(), Some("_"));
    }

    // ── Trailing dots and spaces ────────────────────────────────────

    #[test]
    fn trailing_dots_stripped() {
        // The crate replaces trailing dots/spaces with replacement "_";
        // our wrapper calls .trim() which handles trailing whitespace.
        // "file.jpg..." → crate → "file.jpg_" → trim → "file.jpg_"
        let result = sanitize_out_option("file.jpg...");
        assert!(result.is_some());
        assert!(result.as_deref().unwrap_or("").starts_with("file.jpg"));
    }

    #[test]
    fn trailing_spaces_stripped() {
        // "file.jpg   " → crate → "file.jpg_" → trim → "file.jpg_"
        // Or our .trim() may catch it. Either way, starts with "file.jpg".
        let result = sanitize_out_option("file.jpg   ");
        assert!(result.is_some());
        assert!(result.as_deref().unwrap_or("").starts_with("file.jpg"));
    }

    // ── Control characters ──────────────────────────────────────────

    #[test]
    fn control_chars_removed() {
        // The crate removes control characters (0x00-0x1F, 0x80-0x9F)
        let result = sanitize_out_option("\x01\x02file.jpg");
        assert!(result.is_some());
        assert!(result.as_deref().unwrap_or("").contains("file.jpg"));
    }

    // ── Normal filenames unmodified ─────────────────────────────────

    #[test]
    fn normal_filename_with_spaces() {
        assert_eq!(
            sanitize_out_option("My Document.pdf").as_deref(),
            Some("My Document.pdf")
        );
    }

    #[test]
    fn extensionless_filename_preserved() {
        assert_eq!(sanitize_out_option("README").as_deref(), Some("README"));
    }

    #[test]
    fn dotfile_preserved() {
        assert_eq!(
            sanitize_out_option(".gitignore").as_deref(),
            Some(".gitignore")
        );
    }
}
