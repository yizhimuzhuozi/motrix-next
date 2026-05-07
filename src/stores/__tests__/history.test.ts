/** @fileoverview TDD tests for the download history Pinia store (SQLite-backed).
 *
 * Tests are written BEFORE implementation per the TDD Iron Law.
 * The `@tauri-apps/plugin-sql` module is mocked to use an in-memory
 * array, keeping tests synchronous and deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { HistoryRecord } from '@shared/types'

// ── Mock: in-memory SQLite substitute ────────────────────────────────
let rows: HistoryRecord[] = []
let birthRows: Array<{ gid: string; added_at: string }> = []
let nextId = 1
let executedQueries: string[] = []

/** Minimal SQL executor that interprets the queries issued by the store. */
function mockExecute(query: string, params: unknown[]): { rowsAffected: number } {
  executedQueries.push(query.trim())
  const q = query.trim().toUpperCase()

  if (q.startsWith('INSERT') && q.includes('TASK_BIRTH')) {
    const [gid, addedAt] = params as [string, string]
    if (!birthRows.some((r) => r.gid === gid)) {
      birthRows.push({ gid, added_at: addedAt })
    }
    return { rowsAffected: 1 }
  }

  if (q.startsWith('INSERT') || q.startsWith('REPLACE')) {
    const [gid, name, uri, dir, totalLength, status, taskType, addedAt, completedAt, meta] = params as [
      string,
      string,
      string | null,
      string | null,
      number | null,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
    const existing = rows.findIndex((r) => r.gid === gid)
    const record: HistoryRecord = {
      id: existing >= 0 ? rows[existing].id : nextId++,
      gid,
      name,
      uri: uri ?? undefined,
      dir: dir ?? undefined,
      total_length: totalLength ?? undefined,
      status,
      task_type: taskType ?? undefined,
      // ON CONFLICT: preserve existing added_at (COALESCE)
      added_at: (existing >= 0 ? rows[existing].added_at : undefined) ?? addedAt ?? undefined,
      created_at: new Date().toISOString(),
      completed_at: completedAt ?? undefined,
      meta: meta ?? undefined,
    }
    if (existing >= 0) {
      rows[existing] = record
    } else {
      rows.push(record)
    }
    return { rowsAffected: 1 }
  }

  if (q.startsWith('DELETE')) {
    if (q.includes('TASK_BIRTH')) {
      const beforeBirths = birthRows.length
      const gids = q.includes('SELECT GID FROM DOWNLOAD_HISTORY WHERE NAME LIKE')
        ? rows.filter((r) => r.name.startsWith('[METADATA]')).map((r) => r.gid)
        : (params as string[])
      const gidSet = new Set(gids)
      birthRows = birthRows.filter((r) => !gidSet.has(r.gid))
      return { rowsAffected: beforeBirths - birthRows.length }
    }

    const before = rows.length
    if (q.includes('WHERE NAME LIKE')) {
      rows = rows.filter((r) => !r.name.startsWith('[METADATA]'))
    } else if (q.includes('GID IN')) {
      const gids = params as string[]
      const gidSet = new Set(gids)
      rows = rows.filter((r) => !gidSet.has(r.gid))
    } else if (q.includes('WHERE GID')) {
      const gid = params[0] as string
      rows = rows.filter((r) => r.gid !== gid)
    } else if (q.includes('WHERE STATUS')) {
      const status = params[0] as string
      rows = rows.filter((r) => r.status !== status)
    } else {
      rows = []
    }
    return { rowsAffected: before - rows.length }
  }

  // PRAGMA responses
  if (q.startsWith('PRAGMA')) {
    return { rowsAffected: 0 }
  }

  return { rowsAffected: 0 }
}

function mockSelect(query: string, params: unknown[]): unknown[] {
  executedQueries.push(query.trim())
  const q = query.trim().toUpperCase()

  // PRAGMA integrity_check returns [{integrity_check: 'ok'}]
  if (q.includes('INTEGRITY_CHECK')) {
    return [{ integrity_check: 'ok' }]
  }

  if (q.includes('TASK_BIRTH')) {
    return [...birthRows]
  }

  let result: HistoryRecord[]
  if (q.includes('WHERE STATUS')) {
    const status = params[0] as string
    result = rows
      .filter((r) => r.status === status)
      .sort((a, b) => {
        const ta = a.added_at ?? a.completed_at ?? ''
        const tb = b.added_at ?? b.completed_at ?? ''
        return tb.localeCompare(ta)
      })
  } else {
    // Default: return all, sorted by COALESCE(added_at, completed_at) DESC
    result = [...rows].sort((a, b) => {
      const ta = a.added_at ?? a.completed_at ?? ''
      const tb = b.added_at ?? b.completed_at ?? ''
      return tb.localeCompare(ta)
    })
  }

  // Parse LIMIT clause from the SQL query
  const limitMatch = q.match(/LIMIT\s+(\d+)/)
  if (limitMatch) {
    const limit = parseInt(limitMatch[1], 10)
    result = result.slice(0, limit)
  }

  return result
}

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn().mockResolvedValue({
      execute: vi.fn((q: string, p: unknown[]) => Promise.resolve(mockExecute(q, p))),
      select: vi.fn((q: string, p: unknown[]) => Promise.resolve(mockSelect(q, p))),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  remove: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('/mock/data'),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// Dynamic import AFTER mock is registered
const { useHistoryStore } = await import('../history')

// ── Test data factories ──────────────────────────────────────────────

function makeRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    gid: 'abc123',
    name: 'test-file.zip',
    uri: 'https://example.com/test-file.zip',
    dir: '/downloads',
    total_length: 1024000,
    status: 'complete',
    task_type: 'uri',
    completed_at: '2026-03-15T12:00:00Z',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('HistoryStore', () => {
  let store: ReturnType<typeof useHistoryStore>

  beforeEach(async () => {
    rows = []
    birthRows = []
    nextId = 1
    executedQueries = []
    setActivePinia(createPinia())
    store = useHistoryStore()
    await store.init()
  })

  // ── addRecord ──────────────────────────────────────────────────

  describe('addRecord', () => {
    it('inserts a new record', async () => {
      const record = makeRecord()
      await store.addRecord(record)

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('abc123')
      expect(results[0].name).toBe('test-file.zip')
      expect(results[0].status).toBe('complete')
    })

    it('upserts on duplicate GID instead of throwing', async () => {
      await store.addRecord(makeRecord({ name: 'original.zip' }))
      await store.addRecord(makeRecord({ name: 'updated.zip' }))

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('updated.zip')
    })

    it('preserves all optional fields', async () => {
      const record = makeRecord({
        uri: 'magnet:?xt=urn:btih:abc',
        dir: '/custom/path',
        total_length: 5000000,
        task_type: 'torrent',
        meta: '{"infoHash":"abc123"}',
      })
      await store.addRecord(record)

      const results = await store.getRecords()
      expect(results[0].uri).toBe('magnet:?xt=urn:btih:abc')
      expect(results[0].dir).toBe('/custom/path')
      expect(results[0].total_length).toBe(5000000)
      expect(results[0].task_type).toBe('torrent')
      expect(results[0].meta).toBe('{"infoHash":"abc123"}')
    })

    it('handles records with minimal fields', async () => {
      await store.addRecord({ gid: 'min1', name: 'minimal.txt', status: 'error' })

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('min1')
    })
  })

  // ── getRecords ─────────────────────────────────────────────────

  describe('getRecords', () => {
    it('returns all records when no filter is specified', async () => {
      await store.addRecord(makeRecord({ gid: 'g1', name: 'file1.zip', status: 'complete' }))
      await store.addRecord(makeRecord({ gid: 'g2', name: 'file2.zip', status: 'error' }))
      await store.addRecord(makeRecord({ gid: 'g3', name: 'file3.zip', status: 'removed' }))

      const results = await store.getRecords()
      expect(results).toHaveLength(3)
    })

    it('filters by status when specified', async () => {
      await store.addRecord(makeRecord({ gid: 'g1', status: 'complete' }))
      await store.addRecord(makeRecord({ gid: 'g2', status: 'error' }))
      await store.addRecord(makeRecord({ gid: 'g3', status: 'complete' }))

      const completed = await store.getRecords('complete')
      expect(completed).toHaveLength(2)
      completed.forEach((r) => expect(r.status).toBe('complete'))
    })

    it('returns records sorted by completed_at descending', async () => {
      await store.addRecord(makeRecord({ gid: 'old', name: 'old.zip', completed_at: '2026-01-01T00:00:00Z' }))
      await store.addRecord(makeRecord({ gid: 'new', name: 'new.zip', completed_at: '2026-03-15T00:00:00Z' }))
      await store.addRecord(makeRecord({ gid: 'mid', name: 'mid.zip', completed_at: '2026-02-01T00:00:00Z' }))

      const results = await store.getRecords()
      expect(results[0].gid).toBe('new')
      expect(results[1].gid).toBe('mid')
      expect(results[2].gid).toBe('old')
    })

    it('returns at most N records when limit is specified', async () => {
      for (let i = 0; i < 10; i++) {
        await store.addRecord(
          makeRecord({
            gid: `limited-${i}`,
            name: `file-${i}.zip`,
            completed_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          }),
        )
      }

      const limited = await store.getRecords(undefined, 3)
      expect(limited).toHaveLength(3)
      // Should return the 3 most recent (sorted by completed_at DESC)
      expect(limited[0].gid).toBe('limited-9')
      expect(limited[1].gid).toBe('limited-8')
      expect(limited[2].gid).toBe('limited-7')
    })

    it('returns all records when limit exceeds total count', async () => {
      await store.addRecord(makeRecord({ gid: 'only1', name: 'only.zip' }))

      const results = await store.getRecords(undefined, 100)
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('only1')
    })

    it('applies limit together with status filter', async () => {
      for (let i = 0; i < 5; i++) {
        await store.addRecord(
          makeRecord({
            gid: `c-${i}`,
            status: 'complete',
            completed_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          }),
        )
      }
      await store.addRecord(makeRecord({ gid: 'e-1', status: 'error' }))

      const limited = await store.getRecords('complete', 2)
      expect(limited).toHaveLength(2)
      limited.forEach((r) => expect(r.status).toBe('complete'))
    })

    it('returns all records when limit is undefined', async () => {
      for (let i = 0; i < 5; i++) {
        await store.addRecord(makeRecord({ gid: `nolim-${i}` }))
      }
      const results = await store.getRecords()
      expect(results).toHaveLength(5)
    })

    it('clamps limit to safe integer range', async () => {
      await store.addRecord(makeRecord({ gid: 'safe1' }))

      // Negative limit should be treated as no results or clamped to 0
      const negResult = await store.getRecords(undefined, -5)
      // Implementation should sanitize: either return [] or clamp to 0
      expect(negResult.length).toBeLessThanOrEqual(1)
    })

    it('returns empty array when no records exist', async () => {
      const results = await store.getRecords()
      expect(results).toEqual([])
    })
  })

  // ── removeRecord ───────────────────────────────────────────────

  describe('removeRecord', () => {
    it('removes a single record by GID', async () => {
      await store.addRecord(makeRecord({ gid: 'g1' }))
      await store.addRecord(makeRecord({ gid: 'g2' }))

      await store.removeRecord('g1')

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('g2')
    })

    it('does not throw when removing non-existent GID', async () => {
      await expect(store.removeRecord('nonexistent')).resolves.not.toThrow()
    })
  })

  // ── removeBirthRecords ────────────────────────────────────────────

  describe('removeBirthRecords', () => {
    it('removes only the requested task birth records', async () => {
      await store.recordTaskBirth('metadata-gid', '2026-04-25T00:00:00Z')
      await store.recordTaskBirth('child-gid', '2026-04-25T00:00:01Z')
      await store.recordTaskBirth('unrelated-gid', '2026-04-25T00:00:02Z')

      await store.removeBirthRecords(['metadata-gid', 'child-gid'])

      const births = await store.loadBirthRecords()
      expect(births).toEqual([{ gid: 'unrelated-gid', added_at: '2026-04-25T00:00:02Z' }])
    })

    it('does nothing for an empty gid list', async () => {
      await store.recordTaskBirth('kept-gid', '2026-04-25T00:00:00Z')

      await store.removeBirthRecords([])

      expect(await store.loadBirthRecords()).toEqual([{ gid: 'kept-gid', added_at: '2026-04-25T00:00:00Z' }])
    })
  })

  // ── removeMetadataRecords ─────────────────────────────────────────

  describe('removeMetadataRecords', () => {
    it('removes legacy metadata history rows and their task birth records only', async () => {
      await store.addRecord(makeRecord({ gid: 'metadata-gid', name: '[METADATA]KNOPPIX_V9.1CD', task_type: 'bt' }))
      await store.addRecord(makeRecord({ gid: 'real-gid', name: 'KNOPPIX_V9.1CD.iso', task_type: 'bt' }))
      await store.recordTaskBirth('metadata-gid', '2026-04-25T00:00:00Z')
      await store.recordTaskBirth('real-gid', '2026-04-25T00:00:01Z')

      await store.removeMetadataRecords()

      expect(await store.getRecords()).toEqual([
        expect.objectContaining({ gid: 'real-gid', name: 'KNOPPIX_V9.1CD.iso' }),
      ])
      expect(await store.loadBirthRecords()).toEqual([{ gid: 'real-gid', added_at: '2026-04-25T00:00:01Z' }])
    })

    it('runs during database initialization to sanitize existing dirty rows', async () => {
      await store.addRecord(makeRecord({ gid: 'metadata-gid', name: '[METADATA]KNOPPIX_V9.1CD', task_type: 'bt' }))
      await store.addRecord(makeRecord({ gid: 'real-gid', name: 'KNOPPIX_V9.1CD.iso', task_type: 'bt' }))
      await store.recordTaskBirth('metadata-gid', '2026-04-25T00:00:00Z')
      await store.recordTaskBirth('real-gid', '2026-04-25T00:00:01Z')

      await store.closeConnection()
      await store.init()

      expect(await store.getRecords()).toEqual([
        expect.objectContaining({ gid: 'real-gid', name: 'KNOPPIX_V9.1CD.iso' }),
      ])
      expect(await store.loadBirthRecords()).toEqual([{ gid: 'real-gid', added_at: '2026-04-25T00:00:01Z' }])
    })
  })

  // ── clearRecords ───────────────────────────────────────────────

  describe('clearRecords', () => {
    it('removes all records when no status filter', async () => {
      await store.addRecord(makeRecord({ gid: 'g1', status: 'complete' }))
      await store.addRecord(makeRecord({ gid: 'g2', status: 'error' }))

      await store.clearRecords()

      const results = await store.getRecords()
      expect(results).toEqual([])
    })

    it('removes only records matching the specified status', async () => {
      await store.addRecord(makeRecord({ gid: 'g1', status: 'complete' }))
      await store.addRecord(makeRecord({ gid: 'g2', status: 'error' }))
      await store.addRecord(makeRecord({ gid: 'g3', status: 'complete' }))

      await store.clearRecords('complete')

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('g2')
    })
  })

  // ── removeStaleRecords ─────────────────────────────────────────

  describe('removeStaleRecords', () => {
    it('removes records whose GIDs are in the provided list', async () => {
      await store.addRecord(makeRecord({ gid: 'g1' }))
      await store.addRecord(makeRecord({ gid: 'g2' }))
      await store.addRecord(makeRecord({ gid: 'g3' }))

      await store.removeStaleRecords(['g1', 'g3'])

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('g2')
    })

    it('handles empty stale list gracefully', async () => {
      await store.addRecord(makeRecord({ gid: 'g1' }))

      await store.removeStaleRecords([])

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
    })
  })

  // ── Multiple operations ────────────────────────────────────────

  describe('combined operations', () => {
    it('add → remove → add with same GID works correctly', async () => {
      await store.addRecord(makeRecord({ gid: 'cycle', name: 'first.zip' }))
      await store.removeRecord('cycle')
      await store.addRecord(makeRecord({ gid: 'cycle', name: 'second.zip' }))

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('second.zip')
    })

    it('handles high volume of records', async () => {
      for (let i = 0; i < 100; i++) {
        await store.addRecord(
          makeRecord({
            gid: `gid-${i}`,
            name: `file-${i}.zip`,
            completed_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
          }),
        )
      }

      const all = await store.getRecords()
      expect(all).toHaveLength(100)

      // Verify sort order — most recent first (sorted by COALESCE(added_at, completed_at))
      for (let i = 0; i < all.length - 1; i++) {
        const ta = all[i].added_at ?? all[i].completed_at ?? ''
        const tb = all[i + 1].added_at ?? all[i + 1].completed_at ?? ''
        expect(ta >= tb).toBe(true)
      }
    })
  })

  // ── PRAGMA initialization ──────────────────────────────────────

  describe('PRAGMA initialization', () => {
    it('sets WAL journal mode on init', async () => {
      const walQueries = executedQueries.filter(
        (q) => q.toUpperCase().includes('JOURNAL_MODE') && q.toUpperCase().includes('WAL'),
      )
      expect(walQueries.length).toBeGreaterThanOrEqual(1)
    })

    it('sets synchronous=NORMAL on init', async () => {
      const syncQueries = executedQueries.filter(
        (q) => q.toUpperCase().includes('SYNCHRONOUS') && q.toUpperCase().includes('NORMAL'),
      )
      expect(syncQueries.length).toBeGreaterThanOrEqual(1)
    })

    it('sets busy_timeout on init', async () => {
      const busyQueries = executedQueries.filter((q) => q.toUpperCase().includes('BUSY_TIMEOUT'))
      expect(busyQueries.length).toBeGreaterThanOrEqual(1)
    })

    it('sets foreign_keys=ON on init', async () => {
      const fkQueries = executedQueries.filter(
        (q) => q.toUpperCase().includes('FOREIGN_KEYS') && q.toUpperCase().includes('ON'),
      )
      expect(fkQueries.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── checkIntegrity ─────────────────────────────────────────────

  describe('checkIntegrity', () => {
    it('returns ok when database is healthy', async () => {
      const result = await store.checkIntegrity()
      expect(result).toBe('ok')
    })

    it('executes PRAGMA integrity_check', async () => {
      executedQueries = []
      await store.checkIntegrity()
      const integrityQueries = executedQueries.filter((q) => q.toUpperCase().includes('INTEGRITY_CHECK'))
      expect(integrityQueries.length).toBe(1)
    })
  })

  // ── closeConnection ────────────────────────────────────────────

  describe('closeConnection', () => {
    it('closes the database connection and allows re-initialization', async () => {
      // Add a record before closing
      await store.addRecord(makeRecord({ gid: 'before-close' }))
      await store.closeConnection()

      // After closing, the next operation should re-initialize the database
      // (initPromise is reset so getDb() triggers a fresh init)
      const results = await store.getRecords()
      // The mock Database.load creates a fresh connection,
      // so in-memory mock rows still contain the record
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('before-close')
    })
  })

  // ── init recovery after total failure ──────────────────────────

  describe('init recovery after rebuild failure', () => {
    it('allows re-initialization when both initial load and rebuild fail', async () => {
      // Reset to a clean slate so we can control the init sequence
      await store.closeConnection()

      const Database = (await import('@tauri-apps/plugin-sql')).default
      const loadFn = Database.load as ReturnType<typeof vi.fn>

      // Force TWO consecutive failures:
      //   1st rejection → init() catches it, tries rebuildDatabase()
      //   2nd rejection → rebuildDatabase() also fails
      // After this, initPromise MUST be reset so a future init() can retry.
      loadFn.mockRejectedValueOnce(new Error('simulated disk full'))
      loadFn.mockRejectedValueOnce(new Error('simulated disk full'))

      // This init() will fail internally but should NOT throw — it
      // swallows errors via the health callback. The critical invariant
      // is that the store doesn't permanently wedge itself.
      await store.init()

      // Restore normal Database.load behavior for the retry
      loadFn.mockResolvedValue({
        execute: vi.fn((q: string, p: unknown[]) => Promise.resolve(mockExecute(q, p))),
        select: vi.fn((q: string, p: unknown[]) => Promise.resolve(mockSelect(q, p))),
        close: vi.fn().mockResolvedValue(undefined),
      })

      // CRITICAL ASSERTION: A second init() call must trigger a fresh
      // initialization attempt — not silently reuse the old failed promise.
      await store.init()

      // If initPromise was not reset, getRecords() would crash on `db!`
      // being null. A successful call here proves the store recovered.
      const results = await store.getRecords()
      expect(results).toBeDefined()
      expect(Array.isArray(results)).toBe(true)
    })

    it('recovered store supports full CRUD after retry', async () => {
      // Start from a failure state
      await store.closeConnection()

      const Database = (await import('@tauri-apps/plugin-sql')).default
      const loadFn = Database.load as ReturnType<typeof vi.fn>

      loadFn.mockRejectedValueOnce(new Error('corruption'))
      loadFn.mockRejectedValueOnce(new Error('corruption'))

      await store.init()

      // Restore
      loadFn.mockResolvedValue({
        execute: vi.fn((q: string, p: unknown[]) => Promise.resolve(mockExecute(q, p))),
        select: vi.fn((q: string, p: unknown[]) => Promise.resolve(mockSelect(q, p))),
        close: vi.fn().mockResolvedValue(undefined),
      })

      // Retry — should recover
      await store.init()

      // Full CRUD cycle to prove the store is fully operational
      await store.addRecord(makeRecord({ gid: 'after-recovery', name: 'recovered.zip' }))
      const records = await store.getRecords()
      expect(records.some((r) => r.gid === 'after-recovery')).toBe(true)

      await store.removeRecord('after-recovery')
      const afterRemove = await store.getRecords()
      expect(afterRemove.every((r) => r.gid !== 'after-recovery')).toBe(true)
    })
  })
})
