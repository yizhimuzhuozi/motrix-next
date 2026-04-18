//! Task lifecycle monitor — polls aria2 for status transitions.
//!
//! Runs as a background tokio task, scanning active + stopped slices
//! for new completions, errors, and BT-seeding transitions.
//!
//! Persists history records to the Rust-side `HistoryDb` directly,
//! ensuring task completion data survives even when the WebView is
//! destroyed in lightweight mode (issue #194).
//!
//! Also emits Tauri events to the frontend for notification display
//! when the WebView is available.
//!
//! Port of the frontend `createTaskLifecycleService`.

use crate::aria2::types::Aria2Task;
use crate::history::HistoryDbState;
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

/// Snapshot of a single file within a TaskEvent.
///
/// Mirrors the frontend's `HistoryFileSnapshot` type, enabling correct
/// multi-file deletion and folder-opening after history round-trip.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskEventFile {
    pub path: String,
    pub length: String,
    pub selected: String,
    pub uris: Vec<String>,
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
    /// Full file list snapshot — required for correct multi-file BT
    /// history records (deletion, open-folder, stale detection).
    #[serde(skip_serializing)]
    pub files: Vec<TaskEventFile>,
    /// BT tracker announce list — required for magnet link reconstruction
    /// from history records after session restart.
    #[serde(skip_serializing)]
    pub announce_list: Vec<Vec<String>>,
}

impl TaskEvent {
    fn from_aria2(task: &Aria2Task) -> Self {
        let name = Self::extract_name(task);
        let info_hash = task.info_hash.clone().filter(|h| !h.is_empty());
        let is_bt = task.bittorrent.is_some();

        let files: Vec<TaskEventFile> = task
            .files
            .iter()
            .map(|f| TaskEventFile {
                path: f.path.clone(),
                length: f.length.clone(),
                selected: f.selected.clone(),
                uris: f.uris.iter().map(|u| u.uri.clone()).collect(),
            })
            .collect();

        let announce_list = task
            .bittorrent
            .as_ref()
            .and_then(|bt| bt.announce_list.clone())
            .unwrap_or_default();

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
            files,
            announce_list,
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

/// Builds the JSON `meta` field for a history record.
///
/// Produces a JSON object matching the frontend's `buildHistoryMeta()` format:
/// ```json
/// {
///   "infoHash": "abc123...",
///   "files": [{"path": "...", "length": "...", "selected": "true", "uris": [...]}],
///   "announceList": [["tracker1..."], ["tracker2..."]]
/// }
/// ```
///
/// This is critical for correct behavior after history round-trip:
/// - `infoHash` → BT deduplication in `mergeHistoryIntoTasks()`
/// - `files`    → multi-file folder detection in `resolveOpenTarget()` / `deleteTaskFiles()`
/// - `announceList` → magnet link reconstruction for restart
///
/// Returns `None` for non-BT tasks with a single file and no mirrors
/// (matches the frontend's compact-omission optimization).
fn build_history_meta_json(event: &TaskEvent) -> Option<String> {
    let mut meta = serde_json::Map::new();

    if let Some(ref hash) = event.info_hash {
        meta.insert(
            "infoHash".to_string(),
            serde_json::Value::String(hash.clone()),
        );
    }

    if !event.announce_list.is_empty() {
        let al: Vec<serde_json::Value> = event
            .announce_list
            .iter()
            .map(|tier| {
                serde_json::Value::Array(
                    tier.iter()
                        .map(|t| serde_json::Value::String(t.clone()))
                        .collect(),
                )
            })
            .collect();
        meta.insert("announceList".to_string(), serde_json::Value::Array(al));
    }

    // Snapshot trigger: multi-file OR any file with multiple mirror URIs.
    // Matches the frontend's buildHistoryMeta() condition exactly.
    let has_multiple_files = event.files.len() > 1;
    let has_mirrors = event.files.iter().any(|f| f.uris.len() > 1);
    if has_multiple_files || has_mirrors {
        let files: Vec<serde_json::Value> = event
            .files
            .iter()
            .map(|f| {
                serde_json::json!({
                    "path": f.path,
                    "length": f.length,
                    "selected": f.selected,
                    "uris": f.uris,
                })
            })
            .collect();
        meta.insert("files".to_string(), serde_json::Value::Array(files));
    }

    if meta.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&meta).unwrap_or_default())
    }
}

/// Converts a [`TaskEvent`] into a [`HistoryRecord`] for Rust-side DB persistence.
///
/// This enables the task monitor to write history records directly to the database,
/// bypassing the frontend. Critical for lightweight mode where the WebView is
/// destroyed — without this, task completions during headless operation would
/// be silently lost (issue #194 follow-up).
///
/// The resulting record uses `ON CONFLICT(gid) DO UPDATE` when inserted,
/// so duplicate writes from both Rust and frontend are idempotent.
pub fn build_history_record(event: &TaskEvent, event_name: &str) -> crate::history::HistoryRecord {
    let status = match event_name {
        events::TASK_COMPLETE | events::BT_COMPLETE => "complete",
        events::TASK_ERROR => "error",
        _ => "unknown",
    };

    let task_type = if event.is_bt {
        Some("bt".to_string())
    } else {
        Some("uri".to_string())
    };

    let total_length = event.total_length.parse::<i64>().ok();
    let now = chrono::Utc::now().to_rfc3339();

    // Build structured JSON meta matching the frontend's buildHistoryMeta() format.
    // This ensures historyRecordToTask() can correctly reconstruct multi-file BT
    // tasks for deletion, open-folder, and deduplication.
    let meta = build_history_meta_json(event);

    crate::history::HistoryRecord {
        id: None,
        gid: event.gid.clone(),
        name: event.name.clone(),
        uri: None,
        dir: Some(event.dir.clone()),
        total_length,
        status: status.to_string(),
        task_type,
        added_at: Some(now.clone()),
        created_at: None,
        completed_at: Some(now),
        meta,
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

    // ── Auto-shutdown state ─────────────────────────────────────────
    // Tracks whether active downloads existed during this engine cycle,
    // preventing false triggers on app launch with an empty queue.
    let mut had_active_downloads = false;
    let mut shutdown_triggered = false;

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

        // Track whether this cycle produced a new completion event.
        // Used below to reset `shutdown_triggered` for instant downloads
        // that complete within a single poll window.
        let has_new_completion = events
            .iter()
            .any(|(n, _)| n == events::TASK_COMPLETE || n == events::BT_COMPLETE);

        // Gate on user preference — skip notification events when disabled
        if !events.is_empty() {
            // ── Rust-side history persistence (lightweight mode safety) ──
            // Write completion/error records directly to the DB so they
            // survive even when the WebView is destroyed. Uses UPSERT
            // (ON CONFLICT DO UPDATE) so duplicate writes from both Rust
            // and frontend are idempotent.
            if let Some(db_state) = app.try_state::<HistoryDbState>() {
                for (event_name, payload) in &events {
                    if event_name == events::TASK_COMPLETE
                        || event_name == events::BT_COMPLETE
                        || event_name == events::TASK_ERROR
                    {
                        let record = build_history_record(payload, event_name);
                        let db = db_state.0.clone();
                        // Spawn a non-blocking write — monitor loop must not
                        // block on DB I/O to keep polling responsive.
                        let event_name_owned = event_name.clone();
                        tokio::spawn(async move {
                            if let Err(e) = db.add_record(&record).await {
                                log::warn!(
                                    "task_monitor: history write failed for {event_name_owned}: {e}"
                                );
                            }
                        });
                    }
                }
            }

            let notifications_enabled = app
                .try_state::<super::config::RuntimeConfigState>()
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

        // ── Auto-shutdown detection ─────────────────────────────────
        // Active-download tracking runs unconditionally so that
        // `shutdown_triggered` can reset when new downloads appear
        // after a previous trigger (cancelled or completed).
        {
            let active_dl = count_active_downloads(&all);
            let waiting: usize = aria2.tell_waiting(0, 1).await.map(|w| w.len()).unwrap_or(0);

            if active_dl > 0 || waiting > 0 {
                had_active_downloads = true;
                // New downloads appeared — allow re-detection.
                shutdown_triggered = false;
            }

            // A new completion event means a task went through its full lifecycle
            // (waiting → active → complete) even if we never observed it as active
            // in the 2s poll window (instant download). Treat this as equivalent to
            // "had active downloads" and allow re-triggering.
            if shutdown_triggered && has_new_completion {
                shutdown_triggered = false;
            }

            if !shutdown_triggered && had_active_downloads && active_dl == 0 && waiting == 0 {
                let should_shutdown = app
                    .try_state::<super::config::RuntimeConfigState>()
                    .map(|rc| rc.0.try_read().is_ok_and(|cfg| cfg.shutdown_when_complete))
                    .unwrap_or(false);

                if should_shutdown {
                    shutdown_triggered = true;
                    log::info!("task_monitor: all downloads complete, shutdown requested");

                    // Reset the cancel flag for this new shutdown sequence.
                    // Previous cancellations must not suppress this trigger.
                    if let Some(cancel) = app
                        .try_state::<std::sync::Arc<crate::commands::power::ShutdownCancelState>>()
                    {
                        cancel.reset();
                    }

                    // Notify frontend to show 60s countdown dialog.
                    let _ = app.emit("power:countdown", ());

                    // Lightweight-mode safety net: if the WebView is destroyed,
                    // the frontend can't show a countdown or invoke the command.
                    // Wait 70s (> 60s frontend countdown) then execute directly.
                    let app_clone = app.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(70)).await;
                        // Check cancel flag — set by frontend's cancel_shutdown command
                        let was_cancelled = app_clone
                            .try_state::<std::sync::Arc<crate::commands::power::ShutdownCancelState>>()
                            .map(|s| s.is_cancelled())
                            .unwrap_or(true); // if state missing, assume cancelled (safe default)

                        if !was_cancelled {
                            log::info!("power: lightweight fallback — executing shutdown");
                            if let Err(e) = crate::commands::power::do_shutdown_internal() {
                                log::error!("power: shutdown failed: {e}");
                            }
                        } else {
                            log::info!("power: shutdown cancelled by user");
                        }
                    });
                }
            }
        }
    }
}

/// Counts active downloads, excluding BT tasks that are only seeding.
///
/// A seeder is identified by `bittorrent` metadata present, `seeder == "true"`,
/// and `status == "active"`. These are upload-only tasks that must not block
/// the auto-shutdown trigger.
fn count_active_downloads(tasks: &[Aria2Task]) -> usize {
    tasks
        .iter()
        .filter(|t| {
            t.status == "active" && !(t.bittorrent.is_some() && t.seeder.as_deref() == Some("true"))
        })
        .count()
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
            announce_list: Some(vec![vec!["udp://tracker.example.com:6969".to_string()]]),
            creation_date: None,
            comment: None,
            mode: None,
        });
        task.info_hash = Some("abcdef1234567890".to_string());
        task.seeder = Some(if seeder { "true" } else { "false" }.to_string());
        task
    }

    /// Multi-file BT task — the scenario that triggered the bug.
    /// BT downloads with multiple files need a `files` snapshot in meta
    /// for correct deletion (single trash call) and folder-opening.
    fn make_multi_file_bt_task(gid: &str) -> Aria2Task {
        Aria2Task {
            gid: gid.to_string(),
            status: "active".to_string(),
            total_length: "2048".to_string(),
            completed_length: "2048".to_string(),
            upload_length: "0".to_string(),
            download_speed: "0".to_string(),
            upload_speed: "0".to_string(),
            connections: "0".to_string(),
            dir: "/downloads".to_string(),
            files: vec![
                Aria2File {
                    index: "1".to_string(),
                    path: "/downloads/MyTorrent/video.mkv".to_string(),
                    length: "1536".to_string(),
                    completed_length: "1536".to_string(),
                    selected: "true".to_string(),
                    uris: vec![],
                },
                Aria2File {
                    index: "2".to_string(),
                    path: "/downloads/MyTorrent/subs.srt".to_string(),
                    length: "512".to_string(),
                    completed_length: "512".to_string(),
                    selected: "true".to_string(),
                    uris: vec![],
                },
            ],
            bittorrent: Some(Aria2BtInfo {
                info: Some(Aria2BtName {
                    name: "MyTorrent".to_string(),
                }),
                announce_list: Some(vec![
                    vec!["udp://tracker1.example.com:6969".to_string()],
                    vec!["udp://tracker2.example.com:6969".to_string()],
                ]),
                creation_date: None,
                comment: None,
                mode: Some("multi".to_string()),
            }),
            info_hash: Some("deadbeef".repeat(5)),
            seeder: Some("true".to_string()),
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

    // ── build_history_record unit tests ─────────────────────────────
    //
    // Validates the pure conversion from TaskEvent → HistoryRecord.
    // This function enables Rust-side DB persistence so that history
    // records are written even when the WebView is destroyed in
    // lightweight mode (issue #194 follow-up).

    #[test]
    fn build_history_record_sets_complete_status_for_task_complete() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert_eq!(record.gid, "g1");
        assert_eq!(record.status, "complete");
        assert_eq!(record.name, "test.zip");
        assert!(record.completed_at.is_some());
    }

    #[test]
    fn build_history_record_sets_complete_status_for_bt_complete() {
        let task = make_bt_task("g2", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::BT_COMPLETE);

        assert_eq!(record.gid, "g2");
        assert_eq!(record.status, "complete");
        assert_eq!(record.name, "Ubuntu.iso");
        assert!(record.completed_at.is_some());

        // Meta must be valid JSON containing infoHash (not a raw hex string)
        let meta_str = record.meta.as_ref().expect("meta should be Some for BT");
        let meta: serde_json::Value =
            serde_json::from_str(meta_str).expect("meta must be valid JSON");
        assert_eq!(meta["infoHash"], "abcdef1234567890");
    }

    #[test]
    fn build_history_record_sets_error_status_for_task_error() {
        let task = make_error_task("g3", "5");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_ERROR);

        assert_eq!(record.gid, "g3");
        assert_eq!(record.status, "error");
        assert!(record.completed_at.is_some());
    }

    #[test]
    fn build_history_record_populates_dir_and_total_length() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert_eq!(record.dir, Some("/tmp".to_string()));
        assert_eq!(record.total_length, Some(1024));
    }

    #[test]
    fn build_history_record_derives_task_type_for_bt() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::BT_COMPLETE);

        assert_eq!(record.task_type, Some("bt".to_string()));
    }

    #[test]
    fn build_history_record_derives_task_type_for_uri() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert_eq!(record.task_type, Some("uri".to_string()));
    }

    #[test]
    fn build_history_record_id_is_none() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        // DB auto-assigns the id via AUTOINCREMENT
        assert!(record.id.is_none());
    }

    // ── JSON meta format validation ─────────────────────────────────
    //
    // These tests validate that build_history_record() produces meta in
    // the correct JSON format expected by the frontend's parseHistoryMeta().
    // The old code stored a raw infoHash string, which caused JSON.parse()
    // to fail and all downstream operations to use wrong legacy fallbacks.

    #[test]
    fn bt_meta_is_valid_json_with_info_hash() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::BT_COMPLETE);

        let meta_str = record.meta.as_ref().unwrap();
        let meta: serde_json::Value =
            serde_json::from_str(meta_str).expect("meta must be valid JSON, not a raw hex string");
        assert_eq!(meta["infoHash"], "abcdef1234567890");
        assert!(meta.get("announceList").is_some());
    }

    #[test]
    fn bt_meta_contains_announce_list() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::BT_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();
        let al = meta["announceList"].as_array().unwrap();
        assert_eq!(al.len(), 1);
        assert_eq!(al[0][0], "udp://tracker.example.com:6969");
    }

    #[test]
    fn multi_file_bt_meta_contains_files_snapshot() {
        let task = make_multi_file_bt_task("g1");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::BT_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();

        // Must have files array with both entries
        let files = meta["files"]
            .as_array()
            .expect("meta.files must exist for multi-file BT");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["path"], "/downloads/MyTorrent/video.mkv");
        assert_eq!(files[1]["path"], "/downloads/MyTorrent/subs.srt");
        assert_eq!(files[0]["length"], "1536");
        assert_eq!(files[0]["selected"], "true");
    }

    #[test]
    fn multi_file_bt_meta_has_announce_list_and_info_hash() {
        let task = make_multi_file_bt_task("g1");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::BT_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();

        assert_eq!(meta["infoHash"], "deadbeef".repeat(5));
        let al = meta["announceList"].as_array().unwrap();
        assert_eq!(al.len(), 2);
    }

    #[test]
    fn single_file_uri_task_has_no_meta() {
        // Non-BT single-file tasks should have meta = None
        // (matches frontend's compact-omission optimization)
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert!(
            record.meta.is_none(),
            "single-file URI tasks should omit meta"
        );
    }

    #[test]
    fn single_file_bt_meta_omits_files_but_has_info_hash() {
        // Single-file BT task: meta should have infoHash but NOT files
        // (files snapshot only needed for multi-file or multi-mirror)
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::BT_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();
        assert!(meta.get("infoHash").is_some());
        assert!(
            meta.get("files").is_none(),
            "single-file BT should not include files snapshot"
        );
    }

    #[test]
    fn task_event_from_aria2_populates_files_and_announce_list() {
        let task = make_multi_file_bt_task("g1");
        let event = TaskEvent::from_aria2(&task);

        assert_eq!(event.files.len(), 2);
        assert_eq!(event.files[0].path, "/downloads/MyTorrent/video.mkv");
        assert_eq!(event.files[1].path, "/downloads/MyTorrent/subs.srt");
        assert_eq!(event.announce_list.len(), 2);
    }

    // ── count_active_downloads (auto-shutdown) ──────────────────────
    //
    // Validates the pure helper that determines whether any "real"
    // downloads are in progress.  BT tasks that are only seeding
    // (active + seeder=true) must be excluded so they don't block
    // the auto-shutdown trigger.

    #[test]
    fn count_active_downloads_excludes_bt_seeders() {
        let tasks = vec![
            make_task("g1", "active"),           // real download
            make_bt_task("g2", "active", true),  // seeder — excluded
            make_bt_task("g3", "active", false), // BT download — counted
        ];
        assert_eq!(count_active_downloads(&tasks), 2);
    }

    #[test]
    fn count_active_downloads_ignores_non_active_statuses() {
        let tasks = vec![
            make_task("g1", "complete"),
            make_task("g2", "paused"),
            make_task("g3", "error"),
            make_task("g4", "waiting"),
            make_task("g5", "removed"),
        ];
        assert_eq!(count_active_downloads(&tasks), 0);
    }

    #[test]
    fn count_active_downloads_empty_list_returns_zero() {
        assert_eq!(count_active_downloads(&[]), 0);
    }

    #[test]
    fn count_active_downloads_all_seeders_returns_zero() {
        let tasks = vec![
            make_bt_task("g1", "active", true),
            make_bt_task("g2", "active", true),
        ];
        assert_eq!(count_active_downloads(&tasks), 0);
    }

    #[test]
    fn count_active_downloads_mixed_seeder_and_paused_seeder() {
        // Paused seeder is NOT active, so it shouldn't be counted at all.
        // Active seeder is excluded by the filter.
        // Only the plain active download counts.
        let tasks = vec![
            make_task("g1", "active"),          // counted
            make_bt_task("g2", "paused", true), // not active → ignored
            make_bt_task("g3", "active", true), // seeder → excluded
        ];
        assert_eq!(count_active_downloads(&tasks), 1);
    }
}
