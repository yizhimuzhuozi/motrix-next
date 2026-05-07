/**
 * @fileoverview Runtime lookup table for auto-archived file paths.
 *
 * After auto-archive moves a completed download to a category directory,
 * aria2's `tellStopped` still reports the original download path in
 * `task.files[0].path`.  This module provides a session-scoped Map that
 * stores the post-move path so that all path-consuming code (file-missing
 * badge, open file, show in folder) resolves to the correct location.
 *
 * Cross-session persistence is handled separately by updating the
 * HistoryRecord's `meta.files[].path` in the SQLite database (see
 * `updateHistoryFilePath` in useTaskLifecycle.ts).
 *
 * ## Reactivity architecture
 *
 * The Map itself is a plain JS object (no serialization / devtools needs),
 * but two `shallowRef` counters bridge mutations into Vue's dependency
 * tracking system:
 *
 * - `_version`        — incremented when archived paths change (set/clear).
 *                       Read inside `resolveTaskFilePath` so that computed
 *                       properties depending on it (e.g. TaskItem's
 *                       `fileCheckTargetPath`) re-evaluate immediately.
 *
 * - `recheckTrigger`  — incremented by `requestFileRecheck()` to force all
 *                       visible TaskItems to re-run their file-existence
 *                       check.  Triggered by:
 *                         • Action handlers on file-not-found (immediate)
 *                         • Global periodic timer (background, every 10s)
 */

import { shallowRef } from 'vue'
import type { Aria2Task } from '@shared/types'

// ── Internal state ──────────────────────────────────────────────────

/** gid → normalized forward-slash path after archive move. */
const archivedPaths = new Map<string, string>()

/**
 * Reactivity bridge for archive-path mutations.
 * Read inside `resolveTaskFilePath` to establish Vue dependency tracking;
 * incremented in `setArchivedPath` / `clearArchivedPath` to trigger
 * recomputation of any computed that called `resolveTaskFilePath`.
 */
const _version = shallowRef(0)

/**
 * Reactivity bridge for forced file-existence rechecks.
 * Watched alongside `fileCheckTargetPath` in TaskItem so that bumping
 * this value triggers a fresh `check_path_exists` IPC call even when
 * the resolved path string has not changed.
 */
export const recheckTrigger = shallowRef(0)

// ── Public API ──────────────────────────────────────────────────────

/**
 * Register the post-archive file path for a task.
 * Called once in the MainLayout `onTaskComplete` handler after `move_file` succeeds.
 */
export function setArchivedPath(gid: string, newPath: string): void {
  archivedPaths.set(gid, newPath)
  _version.value++
}

/**
 * Retrieve the archived path for a task, if one exists.
 * Returns `undefined` when the task was not archived in this session.
 */
export function getArchivedPath(gid: string): string | undefined {
  return archivedPaths.get(gid)
}

/**
 * Remove the archived path entry for a task.
 * Called when the task is deleted from the UI to prevent unbounded Map growth.
 */
export function clearArchivedPath(gid: string): void {
  archivedPaths.delete(gid)
  _version.value++
}

/**
 * Request all visible TaskItems to re-run their file-existence check.
 *
 * Call sites:
 *   - `handleShowInFolder` / `handleOpenFile` when they detect file-not-found
 *   - `openFileFromNotification` / `showInFolderFromNotification` (same)
 *   - Global periodic timer in MainLayout (every FILE_RECHECK_INTERVAL ms)
 */
export function requestFileRecheck(): void {
  recheckTrigger.value++
}

/**
 * Unified file path resolver for a completed/stopped task.
 *
 * All code that needs "the file path for this task" MUST go through this
 * function instead of reading `task.files[0].path` directly.
 *
 * Resolution order:
 *   1. Archived path (session Map) — set after auto-archive move
 *   2. task.files[0].path — aria2 original or history-reconstructed path
 *
 * Returns `null` when no file path is available (e.g. metadata-only task).
 *
 * NOTE: Reading `_version.value` establishes a Vue dependency so that any
 * computed calling this function re-evaluates when `setArchivedPath` /
 * `clearArchivedPath` mutates the Map.
 */
export function resolveTaskFilePath(task: Aria2Task): string | null {
  _version.value // Establish Vue reactivity dependency

  const archived = archivedPaths.get(task.gid)
  if (archived) return archived

  const files = task.files
  if (!files || files.length === 0) return null

  const selected = files.filter((f) => f.selected === 'true')
  return (selected.length > 0 ? selected[0] : files[0])?.path ?? null
}
