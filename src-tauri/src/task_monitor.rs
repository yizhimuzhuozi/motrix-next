//! Task lifecycle monitor — polls aria2 for status transitions.
//!
//! Runs as a background tokio task, scanning active + stopped slices
//! for new completions, errors, and BT-seeding transitions.
//! Emits Tauri events to the frontend for notification display and
//! history persistence.
//!
//! Port of the frontend `createTaskLifecycleService`.

use crate::aria2::types::Aria2Task;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::watch;

/// Maximum number of stopped tasks to scan per tick.
const STOPPED_SLICE_LIMIT: i64 = 50;

/// Default polling interval in milliseconds.
const DEFAULT_INTERVAL_MS: u64 = 2000;

/// Events emitted to the frontend.
pub mod events {
    pub const TASK_ERROR: &str = "task-monitor:error";
    pub const TASK_COMPLETE: &str = "task-monitor:complete";
    pub const BT_COMPLETE: &str = "task-monitor:bt-complete";
}

/// Payload for task lifecycle events.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub gid: String,
    pub name: String,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub dir: String,
    pub total_length: String,
    pub completed_length: String,
    pub info_hash: Option<String>,
    pub is_bt: bool,
}

impl TaskEvent {
    fn from_aria2(task: &Aria2Task) -> Self {
        let name = Self::extract_name(task);
        let info_hash = task.info_hash.clone().filter(|h| !h.is_empty());
        let is_bt = task.bittorrent.is_some();
        Self {
            gid: task.gid.clone(),
            name,
            status: task.status.clone(),
            error_code: task.error_code.clone(),
            error_message: task.error_message.clone(),
            dir: task.dir.clone(),
            total_length: task.total_length.clone(),
            completed_length: task.completed_length.clone(),
            info_hash,
            is_bt,
        }
    }

    /// Best-effort task name extraction matching the TS `getTaskName()`.
    fn extract_name(task: &Aria2Task) -> String {
        // BT: prefer bittorrent.info.name
        if let Some(bt) = &task.bittorrent {
            if let Some(info) = &bt.info {
                if !info.name.is_empty() {
                    return info.name.clone();
                }
            }
        }
        // Fallback: first file's path basename
        if let Some(first) = task.files.first() {
            if !first.path.is_empty() {
                let path = &first.path;
                let sep = path.rfind('/').or_else(|| path.rfind('\\'));
                if let Some(idx) = sep {
                    return path[idx + 1..].to_string();
                }
                return path.clone();
            }
        }
        String::new()
    }
}

/// Internal deduplication state — mirrors `createTaskNotifier()` from TS.
pub struct TaskNotifier {
    notified_errors: HashSet<String>,
    notified_completes: HashSet<String>,
    notified_bt_completes: HashSet<String>,
    initial_scan_done: bool,
}

impl TaskNotifier {
    pub fn new() -> Self {
        Self {
            notified_errors: HashSet::new(),
            notified_completes: HashSet::new(),
            notified_bt_completes: HashSet::new(),
            initial_scan_done: false,
        }
    }

    /// Scan tasks and return events that should be emitted.
    ///
    /// Suppresses callbacks during the first scan to avoid ghost
    /// notifications for pre-existing terminal tasks.
    pub fn scan(&mut self, tasks: &[Aria2Task]) -> Vec<(String, TaskEvent)> {
        let mut emit = Vec::new();

        for task in tasks {
            // Error detection
            if task.status == "error" {
                if let Some(code) = &task.error_code {
                    if code != "0" && !self.notified_errors.contains(&task.gid) {
                        self.notified_errors.insert(task.gid.clone());
                        if self.initial_scan_done {
                            emit.push((
                                events::TASK_ERROR.to_string(),
                                TaskEvent::from_aria2(task),
                            ));
                        }
                    }
                }
            }

            // Completion detection
            if task.status == "complete" && !self.notified_completes.contains(&task.gid) {
                self.notified_completes.insert(task.gid.clone());
                if self.initial_scan_done {
                    emit.push((
                        events::TASK_COMPLETE.to_string(),
                        TaskEvent::from_aria2(task),
                    ));
                }
            }

            // BT seeding detection (active + seeder == "true" + has bittorrent)
            if task.bittorrent.is_some()
                && task.seeder.as_deref() == Some("true")
                && task.status == "active"
                && !self.notified_bt_completes.contains(&task.gid)
            {
                self.notified_bt_completes.insert(task.gid.clone());
                if self.initial_scan_done {
                    emit.push((events::BT_COMPLETE.to_string(), TaskEvent::from_aria2(task)));
                }
            }
        }

        if !self.initial_scan_done {
            log::debug!(
                "task_monitor: initial scan suppressed {} pre-existing tasks",
                tasks.len()
            );
        }
        self.initial_scan_done = true;

        emit
    }
}

/// Handle for controlling the background monitor task.
pub struct TaskMonitorHandle {
    /// Send `true` to stop the monitor.
    stop_tx: watch::Sender<bool>,
}

impl TaskMonitorHandle {
    /// Signal the monitor to stop.
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

/// Spawns the task monitor as a background tokio task.
///
/// Returns a handle that can signal the monitor to stop.
pub fn spawn_task_monitor(
    app: tauri::AppHandle,
    aria2: Arc<crate::aria2::client::Aria2Client>,
) -> TaskMonitorHandle {
    let (stop_tx, stop_rx) = watch::channel(false);

    tokio::spawn(async move {
        monitor_loop(app, aria2, stop_rx).await;
    });

    TaskMonitorHandle { stop_tx }
}

async fn monitor_loop(
    app: tauri::AppHandle,
    aria2: Arc<crate::aria2::client::Aria2Client>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut notifier = TaskNotifier::new();
    let interval = Duration::from_millis(DEFAULT_INTERVAL_MS);

    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {},
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    log::info!("task_monitor: stopped");
                    return;
                }
            }
        }

        // Fetch active + stopped tasks
        let active = match aria2.tell_active().await {
            Ok(tasks) => tasks,
            Err(e) => {
                log::debug!("task_monitor: tell_active failed: {e}");
                continue;
            }
        };

        let stopped = match aria2.tell_stopped(0, STOPPED_SLICE_LIMIT).await {
            Ok(tasks) => tasks,
            Err(e) => {
                log::debug!("task_monitor: tell_stopped failed: {e}");
                continue;
            }
        };

        let mut all = active;
        all.extend(stopped);

        let events = notifier.scan(&all);

        // Gate on user preference — skip notification events when disabled
        if !events.is_empty() {
            let notifications_enabled = app
                .try_state::<crate::runtime_config::RuntimeConfigState>()
                .map(|rc| {
                    // Use try_read to avoid blocking the async loop
                    rc.0.try_read().map_or(true, |cfg| cfg.task_notification)
                })
                .unwrap_or(true);

            if notifications_enabled {
                for (event_name, payload) in events {
                    if let Err(e) = app.emit(&event_name, &payload) {
                        log::warn!("task_monitor: failed to emit {event_name}: {e}");
                    }
                }
            } else {
                log::debug!(
                    "task_monitor: suppressed {} events (notifications disabled)",
                    events.len()
                );
            }
        }
    }
}

/// Managed state wrapper for the monitor handle.
pub struct TaskMonitorState(pub Arc<tokio::sync::Mutex<Option<TaskMonitorHandle>>>);

impl TaskMonitorState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aria2::types::{Aria2BtInfo, Aria2BtName, Aria2File};

    fn make_task(gid: &str, status: &str) -> Aria2Task {
        Aria2Task {
            gid: gid.to_string(),
            status: status.to_string(),
            total_length: "1024".to_string(),
            completed_length: "1024".to_string(),
            upload_length: "0".to_string(),
            download_speed: "0".to_string(),
            upload_speed: "0".to_string(),
            connections: "0".to_string(),
            dir: "/tmp".to_string(),
            files: vec![Aria2File {
                index: "1".to_string(),
                path: "/tmp/test.zip".to_string(),
                length: "1024".to_string(),
                completed_length: "1024".to_string(),
                selected: "true".to_string(),
                uris: vec![],
            }],
            bittorrent: None,
            info_hash: None,
            seeder: None,
            num_seeders: None,
            num_pieces: None,
            piece_length: None,
            error_code: None,
            error_message: None,
            bitfield: None,
            verified_length: None,
            verify_integrity_pending: None,
            followed_by: None,
            following: None,
            belongs_to: None,
        }
    }

    fn make_bt_task(gid: &str, status: &str, seeder: bool) -> Aria2Task {
        let mut task = make_task(gid, status);
        task.bittorrent = Some(Aria2BtInfo {
            info: Some(Aria2BtName {
                name: "Ubuntu.iso".to_string(),
            }),
            announce_list: None,
            creation_date: None,
            comment: None,
            mode: None,
        });
        task.info_hash = Some("abcdef1234567890".to_string());
        task.seeder = Some(if seeder { "true" } else { "false" }.to_string());
        task
    }

    fn make_error_task(gid: &str, code: &str) -> Aria2Task {
        let mut task = make_task(gid, "error");
        task.error_code = Some(code.to_string());
        task.error_message = Some("download failed".to_string());
        task
    }

    // ── Initial scan suppression ────────────────────────────────────

    #[test]
    fn initial_scan_suppresses_all_events() {
        let mut notifier = TaskNotifier::new();
        let tasks = vec![
            make_task("g1", "complete"),
            make_error_task("g2", "1"),
            make_bt_task("g3", "active", true),
        ];

        let events = notifier.scan(&tasks);
        assert!(events.is_empty(), "initial scan should suppress all events");
        assert!(notifier.initial_scan_done);
    }

    #[test]
    fn second_scan_emits_new_events() {
        let mut notifier = TaskNotifier::new();
        // Initial scan
        notifier.scan(&[make_task("g1", "complete")]);

        // Second scan with new completion
        let events = notifier.scan(&[
            make_task("g1", "complete"), // already seen
            make_task("g2", "complete"), // new
        ]);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::TASK_COMPLETE);
        assert_eq!(events[0].1.gid, "g2");
    }

    // ── Error detection ─────────────────────────────────────────────

    #[test]
    fn detects_new_error() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);
        // empty initial scan

        let events = notifier.scan(&[make_error_task("g1", "1")]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::TASK_ERROR);
        assert_eq!(events[0].1.error_code, Some("1".to_string()));
    }

    #[test]
    fn error_code_zero_is_ignored() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_error_task("g1", "0")]);
        assert!(events.is_empty(), "error code 0 = success, should not emit");
    }

    #[test]
    fn same_error_not_emitted_twice() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        notifier.scan(&[make_error_task("g1", "3")]);
        let events = notifier.scan(&[make_error_task("g1", "3")]);
        assert!(events.is_empty());
    }

    // ── Completion detection ────────────────────────────────────────

    #[test]
    fn detects_new_completion() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_task("g1", "complete")]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::TASK_COMPLETE);
    }

    #[test]
    fn same_completion_not_emitted_twice() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        notifier.scan(&[make_task("g1", "complete")]);
        let events = notifier.scan(&[make_task("g1", "complete")]);
        assert!(events.is_empty());
    }

    // ── BT seeding detection ────────────────────────────────────────

    #[test]
    fn detects_bt_seeding_start() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_bt_task("g1", "active", true)]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::BT_COMPLETE);
        assert!(events[0].1.is_bt);
    }

    #[test]
    fn bt_not_seeding_is_not_emitted() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_bt_task("g1", "active", false)]);
        assert!(events.is_empty());
    }

    #[test]
    fn bt_seeding_but_not_active_is_not_emitted() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_bt_task("g1", "paused", true)]);
        assert!(events.is_empty());
    }

    // ── Fresh notifier replaces reset ────────────────────────────────

    #[test]
    fn fresh_notifier_has_clean_state() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[make_task("g1", "complete")]);
        assert!(notifier.initial_scan_done);

        // On restart, a new notifier is created — verify it starts clean
        let fresh = TaskNotifier::new();
        assert!(!fresh.initial_scan_done);
        assert!(fresh.notified_completes.is_empty());
        assert!(fresh.notified_errors.is_empty());
        assert!(fresh.notified_bt_completes.is_empty());
    }

    // ── TaskEvent extraction ────────────────────────────────────────

    #[test]
    fn task_event_extracts_name_from_bt_info() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        assert_eq!(event.name, "Ubuntu.iso");
        assert!(event.is_bt);
        assert_eq!(event.info_hash, Some("abcdef1234567890".to_string()));
    }

    #[test]
    fn task_event_extracts_name_from_file_path() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        assert_eq!(event.name, "test.zip");
        assert!(!event.is_bt);
    }

    #[test]
    fn task_event_handles_empty_files() {
        let mut task = make_task("g1", "complete");
        task.files = vec![];
        let event = TaskEvent::from_aria2(&task);
        assert_eq!(event.name, "");
    }

    // ── Mixed event emission ────────────────────────────────────────

    #[test]
    fn emits_multiple_event_types_in_single_scan() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let tasks = vec![
            make_task("g1", "complete"),
            make_error_task("g2", "5"),
            make_bt_task("g3", "active", true),
        ];

        let events = notifier.scan(&tasks);
        assert_eq!(events.len(), 3);

        let types: Vec<&str> = events.iter().map(|(t, _)| t.as_str()).collect();
        assert!(types.contains(&events::TASK_COMPLETE));
        assert!(types.contains(&events::TASK_ERROR));
        assert!(types.contains(&events::BT_COMPLETE));
    }
}
