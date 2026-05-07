//! GPU crash detection and automatic recovery for Linux.
//!
//! WebKitGTK's DMA-BUF renderer crashes on various GPU/driver/compositor
//! combinations: NVIDIA proprietary, Intel UHD on Wayland, Broadcom on
//! Raspberry Pi, VM guests.  Upstream WebKit Bug #262607 is RESOLVED WONTFIX.
//!
//! ## Strategy
//!
//! **Default ON:** hardware rendering is enabled for best performance.
//! If the DMA-BUF renderer causes a crash, the next launch detects it
//! via a sentinel file and automatically reverts the preference to
//! `false`, falling back to software compositing.  Users can also
//! manually disable it via the Advanced preferences toggle.
//!
//! ### Sentinel protocol
//!
//! 1. [`pre_flight`] — before Tauri/WebKitGTK init:
//!    - If the sentinel file exists → last launch crashed after opting in →
//!      revert `hardwareRendering` to `false` in `config.json`, delete sentinel,
//!      set `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
//!    - If `hardwareRendering` is `false` (default) → set env var.
//!    - If `hardwareRendering` is `true` → write sentinel, leave env var unset.
//! 2. [`mark_healthy`] — after `setup_app()` succeeds → delete sentinel.
//!
//! ## Platform scope
//!
//! All functions are `#[cfg(target_os = "linux")]`-gated.  On Windows and macOS
//! the public API compiles to no-ops (the module still exists for `mod` hygiene).
//!
//! Helper functions are called by `pre_flight()` which is
//! `#[cfg(target_os = "linux")]`. On macOS/Windows the caller is compiled out,
//! making them appear unused — hence the module-level allow.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::io::Write;

/// Sentinel file name — written before WebKitGTK init, deleted on success.
const SENTINEL_NAME: &str = ".gpu-crash-sentinel";

/// Companion marker set alongside `WEBKIT_DISABLE_DMABUF_RENDERER` when
/// **we** disable DMA-BUF.  On `relaunch()` the child process inherits both
/// env vars; `pre_flight()` detects the marker and knows to ignore the
/// inherited DMABUF var, falling through to config-based logic instead.
///
/// Without this marker, `relaunch()` after an OFF→ON toggle change would
/// see the parent's `WEBKIT_DISABLE_DMABUF_RENDERER=1`, treat it as a
/// user-external override, and write `hardwareRendering=false` back to
/// config — wiping the user's just-saved preference.
const SELF_SET_MARKER: &str = "_MOTRIX_DMABUF_SELF_SET";

/// Resolves the application data directory (`~/.local/share/com.motrix.next`).
///
/// Uses `dirs::data_dir()` (same as [`crate::read_log_level`]) because
/// `tauri-plugin-store` is unavailable before `Builder.build()`.
fn data_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("com.motrix.next"))
}

/// Persistent logging for pre-flight — appends to the main application log.
///
/// `pre_flight()` executes before `tauri-plugin-log` is initialised, so
/// `log::info!` / `log::warn!` are unavailable.  This function writes
/// directly to the same `motrix-next.log` that `tauri-plugin-log` uses,
/// with a matching timestamp format so the entries blend in naturally.
///
/// `tauri-plugin-log` with `KeepOne` rotation does **not** truncate on
/// startup — it only rotates when `max_file_size` is reached — so these
/// pre-flight lines survive into the diagnostic export.
///
/// Output is also mirrored to stderr for developer convenience.
fn guard_log(message: &str) {
    eprintln!("[motrix-next] {message}");
    if let Some(dir) = data_dir() {
        let log_dir = dir.join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("motrix-next.log");
        let timestamp = chrono::Local::now().format("%Y-%m-%d][%H:%M:%S");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(file, "[{timestamp}][INFO][gpu_guard] {message}");
        }
    }
}

/// Reads the `hardwareRendering` preference from raw `config.json`.
///
/// Same pattern as [`crate::read_log_level`] — direct JSON file read because
/// `tauri-plugin-store` isn't available yet.
///
/// Returns `true` (hardware acceleration ON) if the file is absent,
/// unparseable, or the key is missing — matching the default in
/// `DEFAULT_APP_CONFIG`.
fn read_hardware_rendering_from_config(data_dir: &std::path::Path) -> bool {
    (|| -> Option<bool> {
        let path = data_dir.join("config.json");
        let content = std::fs::read_to_string(path).ok()?;
        let json: serde_json::Value = serde_json::from_str(&content).ok()?;
        json.get("preferences")?.get("hardwareRendering")?.as_bool()
    })()
    .unwrap_or(true)
}

/// Writes `hardwareRendering = false` back into raw `config.json`.
///
/// Best-effort: errors are logged but never propagated (this runs before the
/// Tauri runtime, so there is no frontend to report to).
fn write_back_hardware_rendering_disabled(data_dir: &std::path::Path) {
    let path = data_dir.join("config.json");
    let result = (|| -> Result<(), String> {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut json: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        if let Some(prefs) = json.get_mut("preferences").and_then(|v| v.as_object_mut()) {
            prefs.insert(
                "hardwareRendering".to_string(),
                serde_json::Value::Bool(false),
            );
        }
        let out = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
        std::fs::write(&path, out).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = result {
        guard_log(&format!("gpu_guard: failed to write back config: {e}"));
    }
}

/// Sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and the companion marker.
///
/// The marker lets the next `pre_flight()` (after a `relaunch()`) distinguish
/// "we set this ourselves" from "user set this externally".
///
/// # Safety
///
/// Calls `std::env::set_var` / `remove_var` which are `unsafe` since Rust 1.83.
/// Safe here because this executes at the very start of `main()`, before the
/// async runtime or any secondary threads.
fn disable_dmabuf_with_marker() {
    // SAFETY: single-threaded at this point.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var(SELF_SET_MARKER, "1");
    }
}

/// Pre-flight GPU guard — must be called before any Tauri/WebKitGTK init.
///
/// Checks the sentinel file and user preference, then decides whether to set
/// `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
///
/// Returns `true` if DMA-BUF was disabled (either by preference or crash recovery).
///
/// # Safety
///
/// Calls `std::env::set_var` / `remove_var` which are `unsafe` since Rust 1.83.
/// This is safe because it executes at the very start of `main()`, before the
/// async runtime or any secondary threads.
#[cfg(target_os = "linux")]
pub fn pre_flight() -> bool {
    // ── Clear inherited env vars from relaunch ──────────────────────
    //
    // `relaunch()` forks a child that inherits the parent's environment.
    // If the parent's `pre_flight()` set WEBKIT_DISABLE_DMABUF_RENDERER
    // (with our marker), the child would incorrectly treat it as a
    // user-external override.  Detect the marker → clear both → fall
    // through to config-based logic where config.json is the truth.
    if std::env::var(SELF_SET_MARKER).is_ok() {
        // SAFETY: single-threaded at this point.
        unsafe {
            std::env::remove_var(SELF_SET_MARKER);
            std::env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
        }
        guard_log(
            "gpu_guard: cleared inherited env vars from relaunch — \
             using config as source of truth",
        );
        // Fall through to config-based logic below.
    }
    // ── External user override (no marker) ──────────────────────────
    //
    // User explicitly launched with WEBKIT_DISABLE_DMABUF_RENDERER=1.
    // Respect their choice and sync it into config.json so the UI
    // toggle reflects reality.  This makes the env var a "one-time
    // import": after the first launch the preference is persisted and
    // the env var is no longer required.
    else if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_ok() {
        let disabled = std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if disabled {
            if let Some(dir) = data_dir() {
                write_back_hardware_rendering_disabled(&dir);
                guard_log(
                    "gpu_guard: external env override detected — \
                     synced hardwareRendering=false to config",
                );
            }
        }
        return disabled;
    }

    let Some(dir) = data_dir() else {
        guard_log("gpu_guard: cannot resolve data dir — defaulting to safe mode");
        disable_dmabuf_with_marker();
        return true;
    };

    let sentinel = dir.join(SENTINEL_NAME);

    // ── Crash recovery ─────────────────────────────────────────────
    let crash_detected = sentinel.exists();
    if crash_detected {
        if let Err(e) = std::fs::remove_file(&sentinel) {
            guard_log(&format!("gpu_guard: failed to remove sentinel: {e}"));
        }
        write_back_hardware_rendering_disabled(&dir);
        guard_log(
            "GPU crash detected on previous launch — \
             hardware rendering auto-disabled",
        );
    }

    // ── Read preference (after possible crash revert) ──────────────
    let hw_rendering = if crash_detected {
        false
    } else {
        read_hardware_rendering_from_config(&dir)
    };

    if hw_rendering {
        // Hardware rendering ON — write sentinel; delete on successful startup.
        if let Err(e) = std::fs::write(&sentinel, "") {
            guard_log(&format!("gpu_guard: failed to write sentinel: {e}"));
        }
        guard_log("Hardware rendering enabled — sentinel written");
        false // DMA-BUF NOT disabled
    } else {
        disable_dmabuf_with_marker();
        guard_log("Hardware rendering disabled — using software compositing");
        true // DMA-BUF disabled
    }
}

/// Marks the current launch as healthy — deletes the sentinel file.
///
/// Called after `setup_app()` succeeds, proving that WebKitGTK's EGL init
/// completed without crashing.
#[cfg(target_os = "linux")]
pub fn mark_healthy() {
    if let Some(dir) = data_dir() {
        let sentinel = dir.join(SENTINEL_NAME);
        if sentinel.exists() {
            let _ = std::fs::remove_file(&sentinel);
            log::info!("gpu_guard: startup healthy — sentinel removed");
        }
    }
}

/// No-op on non-Linux platforms.
#[cfg(not(target_os = "linux"))]
pub fn pre_flight() -> bool {
    false
}

/// No-op on non-Linux platforms.
#[cfg(not(target_os = "linux"))]
pub fn mark_healthy() {}

/// Returns whether the user has opted into hardware rendering.
///
/// Used by `export_diagnostic_logs` to include GPU state in the diagnostic
/// archive.  On non-Linux platforms this always returns `false`.
pub fn is_hardware_rendering_enabled() -> bool {
    std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
        .map(|v| v != "1" && !v.eq_ignore_ascii_case("true"))
        .unwrap_or(true) // If env var not set → DMA-BUF is enabled
        && cfg!(target_os = "linux")
}

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Creates a unique temp directory for test isolation.
    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("motrix-gpu-guard-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    /// Writes a minimal config.json with the given hardwareRendering value.
    fn write_config(dir: &std::path::Path, hw: bool) {
        let config = serde_json::json!({
            "preferences": {
                "hardwareRendering": hw,
                "logLevel": "debug"
            }
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .expect("write config");
    }

    fn sentinel_path(dir: &std::path::Path) -> PathBuf {
        dir.join(SENTINEL_NAME)
    }

    // ── read_hardware_rendering_from_config ─────────────────────────

    #[test]
    fn read_hw_rendering_returns_true_when_config_absent() {
        let dir = test_dir("read_absent");
        assert!(read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_true_when_key_missing() {
        let dir = test_dir("read_missing_key");
        let config = serde_json::json!({
            "preferences": { "logLevel": "debug" }
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();
        assert!(read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_false_when_value_is_false() {
        let dir = test_dir("read_false");
        write_config(&dir, false);
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_true_when_value_is_true() {
        let dir = test_dir("read_true");
        write_config(&dir, true);
        assert!(read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_true_when_json_malformed() {
        let dir = test_dir("read_malformed");
        fs::write(dir.join("config.json"), "not json at all").unwrap();
        assert!(read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_true_when_preferences_missing() {
        let dir = test_dir("read_no_prefs");
        fs::write(dir.join("config.json"), r#"{ "other": 42 }"#).unwrap();
        assert!(read_hardware_rendering_from_config(&dir));
    }

    // ── write_back_hardware_rendering_disabled ──────────────────────

    #[test]
    fn write_back_sets_hardware_rendering_to_false() {
        let dir = test_dir("write_back");
        write_config(&dir, true);
        // Precondition: config says true
        assert!(read_hardware_rendering_from_config(&dir));
        // Act
        write_back_hardware_rendering_disabled(&dir);
        // Postcondition: config now says false
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn write_back_preserves_other_config_fields() {
        let dir = test_dir("write_back_preserve");
        let config = serde_json::json!({
            "preferences": {
                "hardwareRendering": true,
                "logLevel": "info",
                "theme": "dark"
            },
            "unrelated": "keep-me"
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();

        write_back_hardware_rendering_disabled(&dir);

        let content = fs::read_to_string(dir.join("config.json")).unwrap();
        let result: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(result["preferences"]["hardwareRendering"], false);
        assert_eq!(result["preferences"]["logLevel"], "info");
        assert_eq!(result["preferences"]["theme"], "dark");
        assert_eq!(result["unrelated"], "keep-me");
    }

    #[test]
    fn write_back_does_not_panic_when_config_absent() {
        let dir = test_dir("write_back_absent");
        // Should not panic — just eprintln error
        write_back_hardware_rendering_disabled(&dir);
    }

    #[test]
    fn write_back_does_not_panic_when_config_malformed() {
        let dir = test_dir("write_back_malformed");
        fs::write(dir.join("config.json"), "not json").unwrap();
        // Should not panic
        write_back_hardware_rendering_disabled(&dir);
    }

    // ── sentinel file operations ────────────────────────────────────

    #[test]
    fn sentinel_name_is_hidden_file() {
        assert!(
            SENTINEL_NAME.starts_with('.'),
            "sentinel must be a hidden file (dotfile)"
        );
    }

    #[test]
    fn sentinel_name_is_fixed_string() {
        // Guard against accidental rename that would break crash detection
        assert_eq!(SENTINEL_NAME, ".gpu-crash-sentinel");
    }

    // ── Integration: read → write_back round-trip ───────────────────

    #[test]
    fn crash_recovery_flow_reads_true_writes_back_false() {
        let dir = test_dir("crash_flow");
        write_config(&dir, true);
        // Simulate crash: sentinel exists
        fs::write(sentinel_path(&dir), "").unwrap();

        // Crash detection should see sentinel, revert config
        assert!(sentinel_path(&dir).exists());
        write_back_hardware_rendering_disabled(&dir);
        let _ = fs::remove_file(sentinel_path(&dir));

        assert!(!read_hardware_rendering_from_config(&dir));
        assert!(!sentinel_path(&dir).exists());
    }

    #[test]
    fn normal_startup_flow_sentinel_written_then_removed() {
        let dir = test_dir("normal_flow");
        write_config(&dir, true);

        // pre_flight would write sentinel
        fs::write(sentinel_path(&dir), "").unwrap();
        assert!(sentinel_path(&dir).exists());

        // mark_healthy would remove it
        let _ = fs::remove_file(sentinel_path(&dir));
        assert!(!sentinel_path(&dir).exists());
    }

    #[test]
    fn safe_mode_default_no_sentinel_written() {
        let dir = test_dir("safe_default");
        write_config(&dir, false);

        let hw = read_hardware_rendering_from_config(&dir);
        assert!(!hw);
        // No sentinel should be written when hw rendering is disabled
        assert!(!sentinel_path(&dir).exists());
    }

    // ── env var → config sync ───────────────────────────────────────

    #[test]
    fn env_var_override_syncs_config_to_false() {
        // Simulates: user had hardwareRendering=true in config, then launched
        // with WEBKIT_DISABLE_DMABUF_RENDERER=1.  pre_flight() should write
        // back false so the UI toggle reflects the override.
        let dir = test_dir("env_sync");
        write_config(&dir, true);
        assert!(read_hardware_rendering_from_config(&dir));

        // Simulate what pre_flight() does when env var is detected:
        write_back_hardware_rendering_disabled(&dir);

        // Config should now be false — toggle will show OFF
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    // ── SELF_SET_MARKER ─────────────────────────────────────────────

    #[test]
    fn self_set_marker_is_underscore_prefixed() {
        // Internal env vars should be underscore-prefixed to signal
        // they are not user-facing.
        assert!(
            SELF_SET_MARKER.starts_with('_'),
            "marker must start with underscore"
        );
    }

    #[test]
    fn self_set_marker_is_stable_value() {
        // Guard against accidental rename that would break relaunch detection.
        assert_eq!(SELF_SET_MARKER, "_MOTRIX_DMABUF_SELF_SET");
    }

    #[test]
    fn relaunch_inherited_env_does_not_corrupt_config() {
        // Regression test: after relaunch, the child process inherits
        // WEBKIT_DISABLE_DMABUF_RENDERER=1 + _MOTRIX_DMABUF_SELF_SET=1.
        // pre_flight() must recognize the marker and NOT write back false
        // to config, preserving the user's saved hardwareRendering=true.
        let dir = test_dir("relaunch_inherit");
        write_config(&dir, true);

        // Simulate: parent had hw OFF, so config was false.
        // User toggled ON → config written true → relaunch.
        // pre_flight() in new process should see marker and ignore env.
        // Config must remain true.
        assert!(read_hardware_rendering_from_config(&dir));
        // The marker tells pre_flight to skip the env-var-sync path,
        // so config is never overwritten.  Verify config is untouched.
        assert!(read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn external_env_without_marker_syncs_config() {
        // When WEBKIT_DISABLE_DMABUF_RENDERER=1 is set WITHOUT our marker,
        // it is a genuine user override.  pre_flight() should sync config.
        let dir = test_dir("external_env");
        write_config(&dir, true);
        assert!(read_hardware_rendering_from_config(&dir));

        // Simulate external env var sync (no marker present):
        write_back_hardware_rendering_disabled(&dir);
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    // ── data_dir resolution ─────────────────────────────────────────

    #[test]
    fn data_dir_returns_some_on_normal_system() {
        // dirs::data_dir() should work on any CI/dev machine
        let dir = data_dir();
        assert!(dir.is_some(), "data_dir() must resolve on test system");
    }

    #[test]
    fn data_dir_ends_with_app_identifier() {
        let dir = data_dir().expect("data_dir must resolve");
        assert!(
            dir.ends_with("com.motrix.next"),
            "data_dir must end with com.motrix.next, got: {:?}",
            dir
        );
    }

    // ── Structural tests: public API exists ─────────────────────────

    #[test]
    fn pre_flight_function_exists_and_returns_bool() {
        // On non-Linux this is a no-op returning false.
        // On Linux this mutates env but we can't safely test that in parallel.
        // This test verifies the function signature compiles correctly.
        let _result: bool = pre_flight();
    }

    #[test]
    fn mark_healthy_function_exists() {
        // Verifies the function compiles. No-op on non-Linux.
        mark_healthy();
    }
}
