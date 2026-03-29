/** @fileoverview Pinia store for SQLite-backed download history persistence.
 *
 * Stores completed/errored download records independently from the aria2
 * session file (which only tracks active/paused tasks). Records survive
 * app restarts and upgrades.
 *
 * Database: sqlite:history.db (managed by tauri-plugin-sql with migrations).
 */
import { defineStore } from 'pinia'
import Database from '@tauri-apps/plugin-sql'
import { remove } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'
import type { HistoryRecord } from '@shared/types'
import { logger } from '@shared/logger'

const DB_NAME = 'sqlite:history.db'

/** Callbacks for database health events — allows UI layer to show toasts
 *  without coupling the store to any specific UI framework. */
export interface DbHealthCallbacks {
  onCorrupt?: () => void
  onError?: (error: unknown) => void
  onRebuilt?: () => void
  onRebuildFailed?: (error: unknown) => void
}

export const useHistoryStore = defineStore('history', () => {
  let db: Awaited<ReturnType<typeof Database.load>> | null = null
  let initPromise: Promise<void> | null = null

  /** Apply SQLite PRAGMA optimizations to an open connection. */
  async function applyPragmas(conn: NonNullable<typeof db>): Promise<void> {
    await conn.execute('PRAGMA journal_mode = WAL', [])
    await conn.execute('PRAGMA synchronous = NORMAL', [])
    await conn.execute('PRAGMA busy_timeout = 5000', [])
    await conn.execute('PRAGMA foreign_keys = ON', [])
  }

  /** Delete the database files from disk (db + WAL + SHM). */
  async function deleteDbFiles(): Promise<void> {
    try {
      const dataDir = await appDataDir()
      const suffixes = ['history.db', 'history.db-wal', 'history.db-shm']
      for (const suffix of suffixes) {
        const path = `${dataDir}/${suffix}`
        if (await invoke<boolean>('check_path_exists', { path })) {
          await remove(path)
        }
      }
    } catch (e) {
      logger.warn('HistoryDB', `deleteDbFiles failed: ${e}`)
    }
  }

  /** Attempt to rebuild the database from scratch after corruption. */
  async function rebuildDatabase(callbacks?: DbHealthCallbacks): Promise<void> {
    try {
      if (db) {
        try {
          await db.close()
        } catch {
          /* already broken */
        }
        db = null
      }
      await deleteDbFiles()
      db = await Database.load(DB_NAME)
      await applyPragmas(db)
      logger.info('HistoryDB', 'Database rebuilt successfully')
      callbacks?.onRebuilt?.()
    } catch (e) {
      logger.error('HistoryDB', `Rebuild failed: ${e}`)
      db = null
      initPromise = null
      callbacks?.onRebuildFailed?.(e)
    }
  }

  /** Initialize the database connection, verify integrity, and auto-recover
   *  from corruption. Safe to call multiple times — subsequent calls are no-ops.
   *
   *  @param callbacks Optional UI notification hooks for health events. */
  async function init(callbacks?: DbHealthCallbacks): Promise<void> {
    if (db) return
    if (!initPromise) {
      initPromise = (async () => {
        try {
          db = await Database.load(DB_NAME)
          await applyPragmas(db)

          // Verify structural integrity on every cold start
          const result = await db.select<{ integrity_check: string }[]>('PRAGMA integrity_check', [])
          const status = result[0]?.integrity_check ?? 'unknown'
          if (status !== 'ok') {
            logger.warn('HistoryDB', `Integrity check failed: ${status}`)
            callbacks?.onCorrupt?.()
            await rebuildDatabase(callbacks)
          }
        } catch (e) {
          logger.warn('HistoryDB', `Init failed: ${e}`)
          callbacks?.onError?.(e)
          await rebuildDatabase(callbacks)
        }
      })()
    }
    await initPromise
  }

  /** Returns the active database connection, auto-initializing if needed. */
  async function getDb() {
    if (!db) await init()
    return db!
  }

  /** Insert or update a download record (upsert by GID).
   *
   *  Uses ON CONFLICT instead of INSERT OR REPLACE to preserve
   *  the immutable added_at timestamp. REPLACE = DELETE + INSERT
   *  which would reset added_at; ON CONFLICT DO UPDATE keeps it. */
  async function addRecord(record: HistoryRecord): Promise<void> {
    await (
      await getDb()
    ).execute(
      `INSERT INTO download_history
        (gid, name, uri, dir, total_length, status, task_type, added_at, completed_at, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(gid) DO UPDATE SET
         name = excluded.name,
         uri = excluded.uri,
         dir = excluded.dir,
         total_length = excluded.total_length,
         status = excluded.status,
         task_type = excluded.task_type,
         added_at = COALESCE(download_history.added_at, excluded.added_at),
         completed_at = excluded.completed_at,
         meta = excluded.meta`,
      [
        record.gid,
        record.name,
        record.uri ?? null,
        record.dir ?? null,
        record.total_length ?? null,
        record.status,
        record.task_type ?? null,
        record.added_at ?? null,
        record.completed_at ?? null,
        record.meta ?? null,
      ],
    )
  }

  /** Retrieve records, optionally filtered by status and/or limited in count.
   *  Sorted by added_at DESC for position-stable ordering.
   *  Falls back to completed_at DESC for records without added_at (pre-migration). */
  async function getRecords(status?: string, limit?: number): Promise<HistoryRecord[]> {
    // Normalize limit: floor → clamp to [0, 10000] → append only if finite
    const limitClause = limit != null ? ` LIMIT ${Math.min(Math.max(0, Math.floor(limit)), 10_000)}` : ''
    const orderBy = 'ORDER BY COALESCE(added_at, completed_at) DESC'
    if (status) {
      return (await getDb()).select<HistoryRecord[]>(
        `SELECT * FROM download_history WHERE status = $1 ${orderBy}${limitClause}`,
        [status],
      )
    }
    return (await getDb()).select<HistoryRecord[]>(`SELECT * FROM download_history ${orderBy}${limitClause}`, [])
  }

  /** Remove a single record by GID. */
  async function removeRecord(gid: string): Promise<void> {
    await (await getDb()).execute('DELETE FROM download_history WHERE gid = $1', [gid])
  }

  /** Remove all records, optionally filtered by status. Full reset also VACUUMs. */
  async function clearRecords(status?: string): Promise<void> {
    if (status) {
      await (await getDb()).execute('DELETE FROM download_history WHERE status = $1', [status])
    } else {
      await (await getDb()).execute('DELETE FROM download_history', [])
      // VACUUM reclaims disk space and resets AUTOINCREMENT counter
      await (await getDb()).execute('VACUUM', [])
    }
  }

  /** Remove records whose GIDs are in the provided list (stale file cleanup). */
  async function removeStaleRecords(gids: string[]): Promise<void> {
    if (gids.length === 0) return
    const placeholders = gids.map((_, i) => `$${i + 1}`).join(', ')
    await (await getDb()).execute(`DELETE FROM download_history WHERE gid IN (${placeholders})`, gids)
  }

  /** Remove records matching a BT infoHash stored in the meta JSON column.
   *
   * Aria2 reassigns GIDs on session restore, so the same torrent may have
   * stale DB records under old GIDs. This method cleans them up before
   * writing a fresh record with the current GID, preventing duplicates.
   *
   * Optionally excludes a specific GID to avoid deleting the record
   * that was just written (INSERT OR REPLACE is by GID, not infoHash). */
  async function removeByInfoHash(infoHash: string, excludeGid?: string): Promise<void> {
    if (!infoHash) return
    if (excludeGid) {
      await (
        await getDb()
      ).execute(`DELETE FROM download_history WHERE json_extract(meta, '$.infoHash') = $1 AND gid != $2`, [
        infoHash,
        excludeGid,
      ])
    } else {
      await (
        await getDb()
      ).execute(`DELETE FROM download_history WHERE json_extract(meta, '$.infoHash') = $1`, [infoHash])
    }
  }

  /** Run PRAGMA integrity_check and return the result string. */
  async function checkIntegrity(): Promise<string> {
    const result = await (await getDb()).select<{ integrity_check: string }[]>('PRAGMA integrity_check', [])
    return result[0]?.integrity_check ?? 'unknown'
  }

  /** Close the database connection and reset initialization state.
   *  After calling, the next init() or getDb() will re-open the database. */
  async function closeConnection(): Promise<void> {
    if (db) {
      await db.close()
      db = null
    }
    initPromise = null
  }

  /** Persist task birth timestamp to the task_birth table.
   *  INSERT OR IGNORE ensures the first write wins — added_at is immutable. */
  async function recordTaskBirth(gid: string, addedAt?: string): Promise<void> {
    await (
      await getDb()
    ).execute(`INSERT OR IGNORE INTO task_birth (gid, added_at) VALUES ($1, $2)`, [
      gid,
      addedAt ?? new Date().toISOString(),
    ])
  }

  /** Load all birth records from the task_birth table.
   *  Called on app startup to pre-populate the in-memory addedAtMap. */
  async function loadBirthRecords(): Promise<Array<{ gid: string; added_at: string }>> {
    return (await getDb()).select<Array<{ gid: string; added_at: string }>>('SELECT gid, added_at FROM task_birth', [])
  }

  /** Query the DB schema version from tauri_plugin_sql's internal tracking table. */
  async function getSchemaVersion(): Promise<number> {
    try {
      const result = await (
        await getDb()
      ).select<Array<{ version: number }>>('SELECT MAX(version) as version FROM _sqlx_migrations', [])
      return result[0]?.version ?? 0
    } catch {
      return 0
    }
  }

  return {
    init,
    addRecord,
    getRecords,
    removeRecord,
    clearRecords,
    removeStaleRecords,
    removeByInfoHash,
    checkIntegrity,
    closeConnection,
    recordTaskBirth,
    loadBirthRecords,
    getSchemaVersion,
  }
})
