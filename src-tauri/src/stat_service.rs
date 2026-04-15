//! Global stat service — polls aria2 for download/upload statistics.
//!
//! Runs as a background tokio task, updating tray title, dock badge,
//! and progress bar directly from Rust without WebView round-trips.
//! Also emits `stat:update` events to the frontend for UI display.
//!
//! Port of the frontend `fetchGlobalStat` in `stores/app.ts`.

use crate::aria2::client::Aria2Client;
use crate::runtime_config::RuntimeConfigState;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::watch;

/// Adaptive polling interval constants (matching TypeScript STAT_* constants).
const STAT_BASE_INTERVAL_MS: u64 = 3000;
const STAT_PER_TASK_INTERVAL_MS: u64 = 200;
const STAT_MIN_INTERVAL_MS: u64 = 500;
const STAT_MAX_INTERVAL_MS: u64 = 6000;
const STAT_IDLE_INCREMENT_MS: u64 = 500;

/// Payload emitted to the frontend via `stat:update`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatUpdate {
    pub download_speed: u64,
    pub upload_speed: u64,
    pub num_active: u64,
    pub num_waiting: u64,
    pub num_stopped: u64,
    pub num_stopped_total: u64,
}

/// Computes a human-readable compact size string (e.g., "1.5M", "200K").
///
/// Matches the frontend `compactSize` output used for tray/dock display.
fn compact_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;

    let b = bytes as f64;
    if b >= GB {
        format!("{:.1}G", b / GB)
    } else if b >= MB {
        format!("{:.1}M", b / MB)
    } else if b >= KB {
        format!("{:.0}K", b / KB)
    } else {
        format!("{b}B")
    }
}

/// Handle for controlling the background stat service.
pub struct StatServiceHandle {
    stop_tx: watch::Sender<bool>,
}

impl StatServiceHandle {
    /// Signal the service to stop.
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

/// Spawns the global stat service as a background tokio task.
pub fn spawn_stat_service(app: tauri::AppHandle, aria2: Arc<Aria2Client>) -> StatServiceHandle {
    let (stop_tx, stop_rx) = watch::channel(false);

    tokio::spawn(async move {
        stat_loop(app, aria2, stop_rx).await;
    });

    StatServiceHandle { stop_tx }
}

/// Adaptive interval state.
struct IntervalState {
    current_ms: u64,
}

impl IntervalState {
    fn new() -> Self {
        Self {
            current_ms: STAT_BASE_INTERVAL_MS,
        }
    }

    /// When tasks are active: interval = base - per_task * num_active (clamped).
    fn update_for_active(&mut self, num_active: u64) {
        let computed = STAT_BASE_INTERVAL_MS
            .saturating_sub(STAT_PER_TASK_INTERVAL_MS.saturating_mul(num_active));
        self.current_ms = computed.max(STAT_MIN_INTERVAL_MS);
    }

    /// When idle: increment interval toward max.
    fn increase_idle(&mut self) {
        self.current_ms = (self.current_ms + STAT_IDLE_INCREMENT_MS).min(STAT_MAX_INTERVAL_MS);
    }

    fn duration(&self) -> Duration {
        Duration::from_millis(self.current_ms)
    }
}

async fn stat_loop(
    app: tauri::AppHandle,
    aria2: Arc<Aria2Client>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut interval_state = IntervalState::new();

    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval_state.duration()) => {},
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    log::info!("stat_service: stopped");
                    return;
                }
            }
        }

        let stat = match aria2.get_global_stat().await {
            Ok(s) => s,
            Err(e) => {
                log::debug!("stat_service: get_global_stat failed: {e}");
                interval_state.increase_idle();
                continue;
            }
        };

        // Parse string values to u64
        let download_speed = stat.download_speed.parse::<u64>().unwrap_or(0);
        let upload_speed = stat.upload_speed.parse::<u64>().unwrap_or(0);
        let num_active = stat.num_active.parse::<u64>().unwrap_or(0);
        let num_waiting = stat.num_waiting.parse::<u64>().unwrap_or(0);
        let num_stopped = stat.num_stopped.parse::<u64>().unwrap_or(0);
        let num_stopped_total = stat.num_stopped_total.parse::<u64>().unwrap_or(0);

        // Adaptive interval
        if num_active > 0 {
            interval_state.update_for_active(num_active);
        } else {
            interval_state.increase_idle();
        }

        // Emit to frontend
        let update = StatUpdate {
            download_speed,
            upload_speed,
            num_active,
            num_waiting,
            num_stopped,
            num_stopped_total,
        };
        let _ = app.emit("stat:update", &update);

        // Update tray/dock from RuntimeConfig
        if let Some(rc_state) = app.try_state::<RuntimeConfigState>() {
            let cfg = rc_state.snapshot().await;

            // Tray title
            if cfg.tray_speedometer && (download_speed > 0 || upload_speed > 0) {
                let title = if download_speed > 0 {
                    format!("↓{}", compact_size(download_speed))
                } else {
                    format!("↑{}", compact_size(upload_speed))
                };
                let _ = app.emit("stat:tray-title", title);
            } else {
                let _ = app.emit("stat:tray-title", String::new());
            }

            // Dock badge
            if cfg.dock_badge_speed && download_speed > 0 {
                let label = format!("{}/s", compact_size(download_speed));
                let _ = app.emit("stat:dock-badge", label);
            } else {
                let _ = app.emit("stat:dock-badge", String::new());
            }

            // Progress bar
            if cfg.show_progress_bar && num_active > 0 {
                // Compute aggregate progress from active tasks
                match aria2.tell_active().await {
                    Ok(tasks) => {
                        let total: u64 = tasks
                            .iter()
                            .filter_map(|t| t.total_length.parse::<u64>().ok())
                            .sum();
                        let completed: u64 = tasks
                            .iter()
                            .filter_map(|t| t.completed_length.parse::<u64>().ok())
                            .sum();
                        let progress = if total > 0 {
                            completed as f64 / total as f64
                        } else {
                            0.0
                        };
                        let _ = app.emit("stat:progress", progress);
                    }
                    Err(e) => {
                        log::debug!("stat_service: tell_active for progress failed: {e}");
                    }
                }
            } else {
                let _ = app.emit("stat:progress", -1.0_f64);
            }
        }
    }
}

/// Managed state wrapper for the stat service handle.
pub struct StatServiceState(pub Arc<tokio::sync::Mutex<Option<StatServiceHandle>>>);

impl StatServiceState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── compact_size ────────────────────────────────────────────────

    #[test]
    fn compact_size_bytes() {
        assert_eq!(compact_size(0), "0B");
        assert_eq!(compact_size(512), "512B");
        assert_eq!(compact_size(1023), "1023B");
    }

    #[test]
    fn compact_size_kilobytes() {
        assert_eq!(compact_size(1024), "1K");
        assert_eq!(compact_size(1536), "2K"); // 1.5K rounds to 2K
        assert_eq!(compact_size(102400), "100K");
    }

    #[test]
    fn compact_size_megabytes() {
        assert_eq!(compact_size(1_048_576), "1.0M");
        assert_eq!(compact_size(1_572_864), "1.5M");
        assert_eq!(compact_size(10_485_760), "10.0M");
    }

    #[test]
    fn compact_size_gigabytes() {
        assert_eq!(compact_size(1_073_741_824), "1.0G");
        assert_eq!(compact_size(2_684_354_560), "2.5G");
    }

    // ── IntervalState ───────────────────────────────────────────────

    #[test]
    fn interval_default_is_base() {
        let state = IntervalState::new();
        assert_eq!(state.current_ms, STAT_BASE_INTERVAL_MS);
    }

    #[test]
    fn interval_active_reduces() {
        let mut state = IntervalState::new();
        state.update_for_active(5);
        // 3000 - (200 * 5) = 2000
        assert_eq!(state.current_ms, 2000);
    }

    #[test]
    fn interval_active_clamps_to_min() {
        let mut state = IntervalState::new();
        state.update_for_active(100);
        assert_eq!(state.current_ms, STAT_MIN_INTERVAL_MS);
    }

    #[test]
    fn interval_idle_increments() {
        let mut state = IntervalState::new();
        state.increase_idle();
        assert_eq!(
            state.current_ms,
            STAT_BASE_INTERVAL_MS + STAT_IDLE_INCREMENT_MS
        );
    }

    #[test]
    fn interval_idle_clamps_to_max() {
        let mut state = IntervalState::new();
        for _ in 0..20 {
            state.increase_idle();
        }
        assert_eq!(state.current_ms, STAT_MAX_INTERVAL_MS);
    }

    #[test]
    fn interval_transitions_between_states() {
        let mut state = IntervalState::new();
        // Go active
        state.update_for_active(3);
        assert_eq!(state.current_ms, 2400); // 3000 - 600
                                            // Go idle
        state.increase_idle();
        assert_eq!(state.current_ms, 2900);
        // Go active again
        state.update_for_active(10);
        assert_eq!(state.current_ms, 1000); // 3000 - 2000
    }

    // ── StatUpdate serialization ────────────────────────────────────

    #[test]
    fn stat_update_serializes_to_camel_case() {
        let update = StatUpdate {
            download_speed: 1024,
            upload_speed: 512,
            num_active: 3,
            num_waiting: 1,
            num_stopped: 5,
            num_stopped_total: 10,
        };
        let json = serde_json::to_value(&update).unwrap();
        assert!(json.get("downloadSpeed").is_some());
        assert!(json.get("numActive").is_some());
        assert!(json.get("numStoppedTotal").is_some());
        // Not snake_case
        assert!(json.get("download_speed").is_none());
    }
}
