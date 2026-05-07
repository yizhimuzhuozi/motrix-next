/** @fileoverview Utilities for download cleanup: stale record detection and torrent file removal.
 *
 * Pure, testable functions — side effects (FS access) are injected via imports.
 */
import { join } from '@tauri-apps/api/path'
import { invoke } from '@tauri-apps/api/core'
import { removePath } from '@/composables/useFileDelete'
import { logger } from '@shared/logger'
import { getTorrentInfoHash } from '@shared/utils/torrentMeta'

/** Record shape needed for stale detection (not the full HistoryRecord). */
export interface StaleCheckItem {
  gid: string
  dir: string
  name: string
  /** All file paths from meta.files — if present, ALL must be gone to count as stale. */
  filePaths?: string[]
}

/** Identify records whose downloaded files no longer exist on disk.
 *  Returns the GIDs of stale records. */
export async function findStaleRecords(records: StaleCheckItem[]): Promise<string[]> {
  const staleGids: string[] = []

  for (const record of records) {
    // Multi-file: only stale if ALL expected files are gone.
    // Early-exit on first existing file for performance.
    if (record.filePaths && record.filePaths.length > 0) {
      let anyExists = false
      for (const fp of record.filePaths) {
        try {
          if (await invoke<boolean>('check_path_exists', { path: fp })) {
            anyExists = true
            break
          }
        } catch (e) {
          logger.debug('StaleCheck', `check_path_exists failed for ${fp}: ${e}`)
        }
      }
      if (!anyExists) staleGids.push(record.gid)
      continue
    }

    // Legacy single-file fallback (unchanged)
    if (!record.dir || !record.name) {
      staleGids.push(record.gid)
      continue
    }

    try {
      const filePath = await join(record.dir, record.name)
      const fileExists = await invoke<boolean>('check_path_exists', { path: filePath })
      if (!fileExists) {
        staleGids.push(record.gid)
      }
    } catch (e) {
      logger.debug('StaleCheck', `path join/check failed for ${record.gid}: ${e}`)
      staleGids.push(record.gid)
    }
  }

  return staleGids
}

/** Move a torrent source file to the OS trash / recycle bin.
 *  Returns true on success, false if the file doesn't exist or the operation fails. */
export async function trashTorrentFile(path: string): Promise<boolean> {
  if (!path) return false

  try {
    const fileExists = await invoke<boolean>('check_path_exists', { path })
    if (!fileExists) return false

    await invoke('trash_file', { path })
    return true
  } catch (e) {
    logger.warn('trashTorrentFile', `Failed to trash ${path}: ${e}`)
    return false
  }
}

/** Check whether the "delete torrent after complete" setting is enabled. */
export function shouldDeleteTorrent(config: Partial<{ deleteTorrentAfterComplete: boolean }>): boolean {
  return config.deleteTorrentAfterComplete === true
}

/** Regex matching aria2's auto-saved metadata filenames: 40-char lowercase hex + .torrent or .meta4 */
const HEX40_METADATA_RE = /^[0-9a-f]{40}\.(torrent|meta4)$/

/**
 * Default hash extractor: reads a .torrent file and delegates metainfo
 * parsing/infoHash extraction to the shared torrent adapter.
 */
async function defaultHashExtractor(filePath: string): Promise<string | null> {
  const bytes = await invoke<number[]>('read_local_file', { path: filePath })
  const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return getTorrentInfoHash(uint8)
}

/** Type for the injectable hash extractor function. */
export type HashExtractor = (filePath: string) => Promise<string | null>

/**
 * Scan the download directory for aria2-saved metadata files and
 * clean up those associated with the given torrent.
 *
 * Handles two file types:
 * - **hex40 `.torrent`**: aria2 names these as `{SHA1(content)}.torrent` (rpc-save-upload-metadata)
 *   or `{infoHash}.torrent` (bt-save-metadata).  We parse each candidate and match by infoHash.
 * - **hex40 `.meta4`**: aria2 names these as `{SHA1(content)}.meta4` (rpc-save-upload-metadata
 *   for metalink).  These can't be parsed for infoHash, so they are removed unconditionally
 *   since only aria2-generated files match the hex40 pattern.
 *
 * Uses `removePath()` (permanent delete) instead of `trashPath()` because these are
 * internal aria2 engine artifacts — not user content.
 *
 * Safety guarantees:
 * - Only files matching `/^[0-9a-f]{40}\.(torrent|meta4)$/` are considered (user files safe)
 * - `.torrent` candidates: parsed infoHash must exactly match the target (no accidental deletion)
 * - All errors are caught and logged (never throws)
 *
 * @param dir       Download directory to scan
 * @param infoHash  Target infoHash to match (from aria2 task status)
 * @param extractHash  Injectable hash extractor for testability
 * @returns true if a matching .torrent file was found and deleted, false otherwise
 */
export async function cleanupAria2MetadataFiles(
  dir: string,
  infoHash: string,
  extractHash: HashExtractor = defaultHashExtractor,
): Promise<boolean> {
  if (!dir || !infoHash) return false

  try {
    const entries = await invoke<string[]>('list_dir_files', { path: dir })
    const candidates = entries.filter((name) => HEX40_METADATA_RE.test(name))

    let torrentMatched = false

    for (const name of candidates) {
      const filePath = await join(dir, name)
      try {
        if (name.endsWith('.meta4')) {
          // .meta4 files can't be parsed for infoHash — they use SHA1(content) naming.
          // Since the only .meta4 files matching hex40 pattern are aria2-generated,
          // we clean all of them for the given dir.
          const removed = await removePath(filePath)
          if (removed) logger.debug('cleanupAria2Metadata', `removed ${name}`)
          continue
        }

        // .torrent: parse and match infoHash
        const hash = await extractHash(filePath)
        if (hash === infoHash) {
          const removed = await removePath(filePath)
          if (removed) logger.debug('cleanupAria2Metadata', `removed ${name}`)
          torrentMatched = removed
          return torrentMatched
        }
      } catch (e) {
        logger.debug('cleanupAria2Metadata', `skipping ${name}: ${e}`)
        continue
      }
    }

    return torrentMatched
  } catch (e) {
    logger.debug('cleanupAria2Metadata', `readDir failed for ${dir}: ${e}`)
    return false
  }
}

/** Backward-compatible alias for cleanupAria2MetadataFiles. */
export const cleanupTorrentMetadataFiles = cleanupAria2MetadataFiles
