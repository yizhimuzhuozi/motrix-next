/** @fileoverview Composable for deleting download task files and associated artifacts from disk.
 *
 * Implements a dual-layer deletion architecture:
 *
 * **Layer 1 — User content (recoverable):**
 * `trashPath()` moves files to the OS trash / recycle bin via the Rust `trash_file`
 * command.  Used for user-downloaded content and user-imported .torrent files.
 * - macOS:  NSFileManager.trashItemAtURL
 * - Windows: IFileOperation + FOFX_RECYCLEONDELETE
 * - Linux:  FreeDesktop Trash spec (XDG_DATA_HOME/Trash)
 *
 * **Layer 2 — Internal metadata (permanent):**
 * `removePath()` permanently deletes files via the Rust `remove_file` command.
 * Used exclusively for internal aria2 metadata that has no user value:
 * - `.aria2` control files (piece bitmap + checksums)
 * - hex40-named `.torrent` metadata (bt-save-metadata / rpc-save-upload-metadata)
 * - hex40-named `.meta4` metadata (rpc-save-upload-metadata for metalink)
 *
 * This replicates what aria2's native `removeControlFile()` does (`std::remove`),
 * which is prevented from running by the `force-save=true` configuration needed
 * for seeding resumption after app restart.
 *
 * Folder detection reuses the existing `resolveOpenTarget` + `check_path_is_dir`
 * infrastructure so folder downloads are trashed in a single OS call (one sound).
 */
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'
import { resolveOpenTarget } from '@shared/utils'
import { cleanupTorrentMetadataFiles } from '@/composables/useDownloadCleanup'
import type { Aria2Task } from '@shared/types'

/**
 * Move a file or directory to the OS trash / recycle bin.
 *
 * Silent no-op when the path is empty, doesn't exist, or the operation fails.
 * Returns `true` if the item was successfully trashed.
 */
export async function trashPath(path: string): Promise<boolean> {
  if (!path) return false
  try {
    const exists = await invoke<boolean>('check_path_exists', { path })
    if (!exists) return false
    await invoke('trash_file', { path })
    return true
  } catch (e) {
    logger.debug('trashPath', `Failed to trash ${path}: ${e}`)
    return false
  }
}

/**
 * Permanently delete a file from disk (NOT move to trash).
 *
 * Used exclusively for internal aria2 metadata files:
 * - `.aria2` control files (piece bitmap + checksum — no user value)
 * - hex40-named `.torrent` metadata (aria2 bt-save-metadata cache)
 * - hex40-named `.meta4` metadata (aria2 rpc-save-upload-metadata for metalink)
 *
 * Silent no-op when the path is empty, doesn't exist, or fails.
 * Returns `true` if the file was successfully removed.
 *
 * SAFETY: Never use this for user-downloaded content — use trashPath() instead.
 */
export async function removePath(path: string): Promise<boolean> {
  if (!path) return false
  try {
    const exists = await invoke<boolean>('check_path_exists', { path })
    if (!exists) return false
    await invoke('remove_file', { path })
    return true
  } catch (e) {
    logger.debug('removePath', `Failed to remove ${path}: ${e}`)
    return false
  }
}

/**
 * Clean up the `.aria2` control file for a completed/stopped BT task.
 *
 * aria2 keeps `.aria2` files alive when `force-save=true` (required for
 * seeding resumption). This function replicates what aria2's native
 * `removeControlFile()` would have done — permanent deletion.
 *
 * Path resolution mirrors `deleteTaskFiles()` for consistency.
 *
 * Safe to call after BT download completes:
 * - From `stopSeeding()` (user manually stops)
 * - From `onTaskComplete()` (aria2 auto-stops via seed-time/seed-ratio)
 */
export async function cleanupAria2ControlFile(task: Aria2Task): Promise<void> {
  if (!task.bittorrent) return

  try {
    const target = await resolveOpenTarget(task)

    if (!target || target === task.dir) {
      // Fallback: per-file cleanup
      for (const f of task.files || []) {
        if (f.path) await removePath(f.path + '.aria2')
      }
      return
    }

    await removePath(target + '.aria2')
  } catch (e) {
    logger.debug('cleanupAria2ControlFile', `cleanup failed: ${e}`)
  }
}

/**
 * Moves all files associated with a download task to the OS trash.
 *
 * Uses `resolveOpenTarget()` to determine the primary target path, then
 * `check_path_is_dir` to detect whether it's a folder or single file:
 *
 * - **Folder download** (BT multi-file): trashes the entire directory in one
 *   OS call — eliminates the N×2 individual trash calls that caused multiple
 *   delete sounds on macOS.  Also trashes the external `.aria2` control file
 *   that sits alongside the directory.
 *
 * - **Single-file download** (HTTP/BT single): trashes the file and its
 *   companion `.aria2` control file.
 *
 * - **Fallback** (no resolvable target): trashes files individually.
 *
 * For BT tasks, also cleans up the hex40-named `.torrent` metadata file that
 * aria2 saves via `rpc-save-upload-metadata` / `bt-save-metadata`.
 *
 * Safety: the download directory itself is NEVER trashed — `resolveOpenTarget`
 * returns `dir` only as a fallback, and that case delegates to per-file trash.
 */
export async function deleteTaskFiles(task: Aria2Task): Promise<void> {
  const target = await resolveOpenTarget(task)

  // Fallback: resolveOpenTarget returned the bare download directory,
  // meaning no specific file/folder could be resolved — trash individually.
  if (!target || target === task.dir) {
    await trashFilesIndividually(task)
    return
  }

  const isDir = await invoke<boolean>('check_path_is_dir', { path: target })
  if (isDir) {
    // Folder task: trash the entire directory in a single OS call
    await trashPath(target)
    // External .aria2 control file sits alongside the folder (e.g., "My Torrent.aria2")
    await trashPath(target + '.aria2')
  } else {
    // Single-file task: trash the file + companion .aria2 control file
    await trashPath(target)
    await trashPath(target + '.aria2')
  }

  // BT tasks: clean up the hex40-named .torrent metadata file in the download dir
  if (task.dir && task.infoHash) {
    await cleanupTorrentMetadataFiles(task.dir, task.infoHash)
  }
}

/**
 * Fallback: trash files one by one.
 * Used when `resolveOpenTarget` cannot determine a specific target
 * (e.g., magnet still resolving metadata, or task with empty file list).
 */
async function trashFilesIndividually(task: Aria2Task): Promise<void> {
  for (const f of task.files || []) {
    if (!f.path) continue
    await trashPath(f.path)
    await trashPath(f.path + '.aria2')
  }
}
