//! Runtime configuration cache for Rust-side consumers.
//!
//! Holds a subset of `AppConfig` preferences needed by background services
//! (monitors, scheduler, tray, stat service) so they don't have to read
//! `config.json` on every tick.
//!
//! Refreshed by the frontend via `invoke('refresh_runtime_config')` after
//! any config save operation.

use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Subset of `AppConfig` fields consumed by Rust runtime services.
///
/// Field names use `camelCase` via `#[serde(rename_all = "camelCase")]` to
/// match the JSON layout in `config.json`'s `preferences` object.
///
/// Fields are consumed by monitor, scheduler, and stat_service (Tasks 5-7).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    #[serde(default)]
    pub speed_limit_enabled: bool,
    #[serde(default)]
    pub speed_schedule_enabled: bool,
    #[serde(default = "default_schedule_from")]
    pub speed_schedule_from: String,
    #[serde(default = "default_schedule_to")]
    pub speed_schedule_to: String,
    #[serde(default)]
    pub speed_schedule_days: u8,
    #[serde(default)]
    pub max_overall_download_limit: String,
    #[serde(default)]
    pub max_overall_upload_limit: String,
    #[serde(default = "default_true")]
    pub task_notification: bool,
    #[serde(default)]
    pub tray_speedometer: bool,
    #[serde(default = "default_true")]
    pub dock_badge_speed: bool,
    #[serde(default)]
    pub show_progress_bar: bool,
}

fn default_true() -> bool {
    true
}

fn default_schedule_from() -> String {
    "00:00".to_string()
}

fn default_schedule_to() -> String {
    "06:00".to_string()
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            speed_limit_enabled: false,
            speed_schedule_enabled: false,
            speed_schedule_from: default_schedule_from(),
            speed_schedule_to: default_schedule_to(),
            speed_schedule_days: 0,
            max_overall_download_limit: String::new(),
            max_overall_upload_limit: String::new(),
            task_notification: true,
            tray_speedometer: false,
            dock_badge_speed: true,
            show_progress_bar: false,
        }
    }
}

/// Tauri managed state: holds the live RuntimeConfig behind a `RwLock`.
pub struct RuntimeConfigState(pub Arc<RwLock<RuntimeConfig>>);

impl RuntimeConfigState {
    pub fn new() -> Self {
        Self(Arc::new(RwLock::new(RuntimeConfig::default())))
    }

    /// Replace the entire config from a deserialized JSON value.
    ///
    /// Called when the frontend saves preferences.  Extracts the
    /// `RuntimeConfig` subset from the full `AppConfig` JSON.
    pub async fn refresh_from_json(&self, prefs: &serde_json::Value) -> Result<(), String> {
        let cfg: RuntimeConfig = serde_json::from_value(prefs.clone())
            .map_err(|e| format!("Failed to parse runtime config: {e}"))?;
        *self.0.write().await = cfg;
        log::info!("runtime_config refreshed");
        Ok(())
    }

    /// Read-only snapshot of the current config.
    pub async fn snapshot(&self) -> RuntimeConfig {
        self.0.read().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Default values ──────────────────────────────────────────────

    #[test]
    fn default_config_has_sane_values() {
        let cfg = RuntimeConfig::default();
        assert!(!cfg.speed_limit_enabled);
        assert!(!cfg.speed_schedule_enabled);
        assert_eq!(cfg.speed_schedule_from, "00:00");
        assert_eq!(cfg.speed_schedule_to, "06:00");
        assert_eq!(cfg.speed_schedule_days, 0);
        assert!(cfg.max_overall_download_limit.is_empty());
        assert!(cfg.max_overall_upload_limit.is_empty());
        assert!(cfg.task_notification); // default ON
        assert!(!cfg.tray_speedometer); // default OFF
        assert!(cfg.dock_badge_speed); // default ON
        assert!(!cfg.show_progress_bar);
    }

    // ── Deserialization from AppConfig-shaped JSON ───────────────────

    #[test]
    fn deserialize_full_appconfig_json_extracts_runtime_fields() {
        let json = serde_json::json!({
            "speedLimitEnabled": true,
            "speedScheduleEnabled": true,
            "speedScheduleFrom": "22:00",
            "speedScheduleTo": "08:00",
            "speedScheduleDays": 31,
            "maxOverallDownloadLimit": "1M",
            "maxOverallUploadLimit": "512K",
            "taskNotification": false,
            "traySpeedometer": true,
            "dockBadgeSpeed": false,
            "showProgressBar": true,
            // Extra fields from AppConfig that RuntimeConfig ignores:
            "theme": "dark",
            "locale": "en-US",
            "dir": "/downloads",
            "split": 16,
            "rpcListenPort": 16800,
            "rpcSecret": "changeme"
        });

        let cfg: RuntimeConfig = serde_json::from_value(json).expect("deserialize");
        assert!(cfg.speed_limit_enabled);
        assert!(cfg.speed_schedule_enabled);
        assert_eq!(cfg.speed_schedule_from, "22:00");
        assert_eq!(cfg.speed_schedule_to, "08:00");
        assert_eq!(cfg.speed_schedule_days, 31);
        assert_eq!(cfg.max_overall_download_limit, "1M");
        assert_eq!(cfg.max_overall_upload_limit, "512K");
        assert!(!cfg.task_notification);
        assert!(cfg.tray_speedometer);
        assert!(!cfg.dock_badge_speed);
        assert!(cfg.show_progress_bar);
    }

    #[test]
    fn deserialize_empty_json_uses_defaults() {
        let json = serde_json::json!({});
        let cfg: RuntimeConfig = serde_json::from_value(json).expect("deserialize");
        assert!(!cfg.speed_limit_enabled);
        assert!(cfg.task_notification); // default true
        assert!(cfg.dock_badge_speed); // default true
        assert_eq!(cfg.speed_schedule_from, "00:00");
        assert_eq!(cfg.speed_schedule_to, "06:00");
    }

    #[test]
    fn deserialize_ignores_unknown_fields() {
        let json = serde_json::json!({
            "speedLimitEnabled": true,
            "unknownField": "should be ignored",
            "anotherUnknown": 42
        });
        let cfg: RuntimeConfig = serde_json::from_value(json).expect("deserialize");
        assert!(cfg.speed_limit_enabled);
    }

    // ── RuntimeConfigState ──────────────────────────────────────────

    #[tokio::test]
    async fn state_new_creates_default_config() {
        let state = RuntimeConfigState::new();
        let snap = state.snapshot().await;
        assert!(!snap.speed_limit_enabled);
        assert!(snap.task_notification);
    }

    #[tokio::test]
    async fn refresh_from_json_updates_config() {
        let state = RuntimeConfigState::new();
        let json = serde_json::json!({
            "speedLimitEnabled": true,
            "taskNotification": false,
            "traySpeedometer": true,
            "speedScheduleFrom": "23:00",
            "speedScheduleTo": "07:00"
        });
        state.refresh_from_json(&json).await.expect("refresh");

        let snap = state.snapshot().await;
        assert!(snap.speed_limit_enabled);
        assert!(!snap.task_notification);
        assert!(snap.tray_speedometer);
        assert_eq!(snap.speed_schedule_from, "23:00");
        assert_eq!(snap.speed_schedule_to, "07:00");
    }

    #[tokio::test]
    async fn refresh_from_json_rejects_invalid_json() {
        let state = RuntimeConfigState::new();
        // speedScheduleDays expects u8, not a string
        let json = serde_json::json!({
            "speedScheduleDays": "not_a_number"
        });
        let result = state.refresh_from_json(&json).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse"));
    }

    #[tokio::test]
    async fn snapshot_returns_cloned_value() {
        let state = RuntimeConfigState::new();
        let snap1 = state.snapshot().await;

        // Mutate via refresh
        let json = serde_json::json!({ "speedLimitEnabled": true });
        state.refresh_from_json(&json).await.expect("refresh");

        // snap1 is a clone, should still be false
        assert!(!snap1.speed_limit_enabled);
        // New snapshot reflects the update
        let snap2 = state.snapshot().await;
        assert!(snap2.speed_limit_enabled);
    }
}
