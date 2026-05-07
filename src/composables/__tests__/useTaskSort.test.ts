/**
 * @fileoverview TDD test suite for per-tab task sorting.
 *
 * Tests are written BEFORE implementation to drive the API design.
 * Sort fields per tab:
 *   Active:  added-at | name | size | progress | speed
 *   Stopped: added-at | completed-at | name | size
 *   All:     added-at | name | size
 * Every field supports 'asc' and 'desc' direction.
 */
import { describe, it, expect } from 'vitest'
import type { Aria2Task, HistoryRecord } from '@shared/types'
import {
  sortTasks,
  sortRecords,
  ACTIVE_SORT_FIELDS,
  STOPPED_SORT_FIELDS,
  ALL_SORT_FIELDS,
  DEFAULT_TASK_SORT,
} from '../useTaskSort'

// ── Factories ────────────────────────────────────────────────────────

function mockTask(gid: string, overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid,
    status: 'active',
    totalLength: '1000',
    completedLength: '500',
    uploadLength: '0',
    downloadSpeed: '100',
    uploadSpeed: '0',
    connections: '1',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: `/downloads/${gid}.txt`,
        length: '1000',
        completedLength: '500',
        selected: 'true',
        uris: [],
      },
    ],
    ...overrides,
  }
}

function mockBtTask(gid: string, name: string, overrides: Partial<Aria2Task> = {}): Aria2Task {
  return mockTask(gid, {
    bittorrent: { info: { name } },
    ...overrides,
  })
}

function mockRecord(gid: string, overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    gid,
    name: `file-${gid}`,
    status: 'complete',
    task_type: 'uri',
    added_at: '2024-01-01T00:00:00Z',
    completed_at: '2024-01-01T01:00:00Z',
    total_length: 1000,
    ...overrides,
  }
}

// ── Helper: extract GID order after sort ─────────────────────────────

function gids(items: Array<{ gid: string }>): string[] {
  return items.map((i) => i.gid)
}

// ═════════════════════════════════════════════════════════════════════
// sortTasks — used by Active and All tabs
// ═════════════════════════════════════════════════════════════════════

describe('sortTasks', () => {
  // ── added-at sorting ───────────────────────────────────────────────

  describe('field: added-at', () => {
    const addedAtIndex = new Map([
      ['a', '2024-01-03T00:00:00Z'],
      ['b', '2024-01-01T00:00:00Z'],
      ['c', '2024-01-02T00:00:00Z'],
    ])

    it('sorts DESC — most recently added first', () => {
      const tasks = [mockTask('b'), mockTask('c'), mockTask('a')]
      sortTasks(tasks, 'added-at', 'desc', addedAtIndex)
      expect(gids(tasks)).toEqual(['a', 'c', 'b'])
    })

    it('sorts ASC — oldest first', () => {
      const tasks = [mockTask('a'), mockTask('c'), mockTask('b')]
      sortTasks(tasks, 'added-at', 'asc', addedAtIndex)
      expect(gids(tasks)).toEqual(['b', 'c', 'a'])
    })

    it('tasks without added-at sort to the end in DESC', () => {
      const index = new Map([['a', '2024-01-02T00:00:00Z']])
      const tasks = [mockTask('b'), mockTask('a')]
      sortTasks(tasks, 'added-at', 'desc', index)
      expect(gids(tasks)).toEqual(['a', 'b'])
    })

    it('tasks without added-at sort to the beginning in ASC', () => {
      const index = new Map([['a', '2024-01-02T00:00:00Z']])
      const tasks = [mockTask('a'), mockTask('b')]
      sortTasks(tasks, 'added-at', 'asc', index)
      expect(gids(tasks)).toEqual(['b', 'a'])
    })
  })

  // ── name sorting ───────────────────────────────────────────────────

  describe('field: name', () => {
    it('sorts A-Z (ASC)', () => {
      const tasks = [mockBtTask('c', 'Zebra'), mockBtTask('a', 'Alpha'), mockBtTask('b', 'Mango')]
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(gids(tasks)).toEqual(['a', 'b', 'c'])
    })

    it('sorts Z-A (DESC)', () => {
      const tasks = [mockBtTask('a', 'Alpha'), mockBtTask('c', 'Zebra'), mockBtTask('b', 'Mango')]
      sortTasks(tasks, 'name', 'desc', new Map())
      expect(gids(tasks)).toEqual(['c', 'b', 'a'])
    })

    it('is case-insensitive', () => {
      const tasks = [mockBtTask('b', 'banana'), mockBtTask('a', 'Apple')]
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(gids(tasks)).toEqual(['a', 'b'])
    })

    it('falls back to file path when no BT name', () => {
      const t1 = mockTask('a', {
        files: [{ index: '1', path: '/dl/zebra.iso', length: '0', completedLength: '0', selected: 'true', uris: [] }],
      })
      const t2 = mockTask('b', {
        files: [{ index: '1', path: '/dl/alpha.iso', length: '0', completedLength: '0', selected: 'true', uris: [] }],
      })
      const tasks = [t1, t2]
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a'])
    })
  })

  // ── size sorting ──────────────────────────────────────────────────

  describe('field: size', () => {
    it('sorts largest first (DESC)', () => {
      const tasks = [
        mockTask('a', { totalLength: '500' }),
        mockTask('b', { totalLength: '2000' }),
        mockTask('c', { totalLength: '100' }),
      ]
      sortTasks(tasks, 'size', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a', 'c'])
    })

    it('sorts smallest first (ASC)', () => {
      const tasks = [
        mockTask('b', { totalLength: '2000' }),
        mockTask('a', { totalLength: '500' }),
        mockTask('c', { totalLength: '100' }),
      ]
      sortTasks(tasks, 'size', 'asc', new Map())
      expect(gids(tasks)).toEqual(['c', 'a', 'b'])
    })

    it('treats missing totalLength as 0', () => {
      const t1 = mockTask('a', { totalLength: '1000' })
      const t2 = mockTask('b', { totalLength: '0' })
      sortTasks([t1, t2], 'size', 'desc', new Map())
      expect(gids([t1, t2])).toEqual(['a', 'b'])
    })
  })

  // ── progress sorting (Active tab only) ────────────────────────────

  describe('field: progress', () => {
    it('sorts highest progress first (DESC)', () => {
      const tasks = [
        mockTask('a', { totalLength: '1000', completedLength: '500' }), // 50%
        mockTask('b', { totalLength: '1000', completedLength: '900' }), // 90%
        mockTask('c', { totalLength: '1000', completedLength: '100' }), // 10%
      ]
      sortTasks(tasks, 'progress', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a', 'c'])
    })

    it('sorts lowest progress first (ASC)', () => {
      const tasks = [
        mockTask('b', { totalLength: '1000', completedLength: '900' }), // 90%
        mockTask('a', { totalLength: '1000', completedLength: '500' }), // 50%
        mockTask('c', { totalLength: '1000', completedLength: '100' }), // 10%
      ]
      sortTasks(tasks, 'progress', 'asc', new Map())
      expect(gids(tasks)).toEqual(['c', 'a', 'b'])
    })

    it('treats zero totalLength as 0% progress', () => {
      const tasks = [
        mockTask('a', { totalLength: '0', completedLength: '0' }),
        mockTask('b', { totalLength: '1000', completedLength: '500' }),
      ]
      sortTasks(tasks, 'progress', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a'])
    })
  })

  // ── speed sorting (Active tab only) ───────────────────────────────

  describe('field: speed', () => {
    it('sorts fastest first (DESC)', () => {
      const tasks = [
        mockTask('a', { downloadSpeed: '500' }),
        mockTask('b', { downloadSpeed: '2000' }),
        mockTask('c', { downloadSpeed: '100' }),
      ]
      sortTasks(tasks, 'speed', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a', 'c'])
    })

    it('sorts slowest first (ASC)', () => {
      const tasks = [
        mockTask('b', { downloadSpeed: '2000' }),
        mockTask('a', { downloadSpeed: '500' }),
        mockTask('c', { downloadSpeed: '100' }),
      ]
      sortTasks(tasks, 'speed', 'asc', new Map())
      expect(gids(tasks)).toEqual(['c', 'a', 'b'])
    })

    it('treats zero speed correctly', () => {
      const tasks = [mockTask('a', { downloadSpeed: '0' }), mockTask('b', { downloadSpeed: '1000' })]
      sortTasks(tasks, 'speed', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a'])
    })
  })

  // ── edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty array', () => {
      const tasks: Aria2Task[] = []
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(tasks).toEqual([])
    })

    it('handles single-element array', () => {
      const tasks = [mockTask('a')]
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(gids(tasks)).toEqual(['a'])
    })

    it('does not crash on tasks with missing files', () => {
      const t = mockTask('a', { files: [] })
      expect(() => sortTasks([t], 'name', 'asc', new Map())).not.toThrow()
    })
  })
})

// ═════════════════════════════════════════════════════════════════════
// sortRecords — used by Stopped tab
// ═════════════════════════════════════════════════════════════════════

describe('sortRecords', () => {
  // ── added-at sorting ──────────────────────────────────────────────

  describe('field: added-at', () => {
    it('sorts DESC — most recently added first', () => {
      const records = [
        mockRecord('b', { added_at: '2024-01-01T00:00:00Z' }),
        mockRecord('a', { added_at: '2024-01-03T00:00:00Z' }),
        mockRecord('c', { added_at: '2024-01-02T00:00:00Z' }),
      ]
      sortRecords(records, 'added-at', 'desc')
      expect(gids(records)).toEqual(['a', 'c', 'b'])
    })

    it('sorts ASC', () => {
      const records = [
        mockRecord('a', { added_at: '2024-01-03T00:00:00Z' }),
        mockRecord('b', { added_at: '2024-01-01T00:00:00Z' }),
      ]
      sortRecords(records, 'added-at', 'asc')
      expect(gids(records)).toEqual(['b', 'a'])
    })

    it('falls back to completed_at when added_at is null', () => {
      const records = [
        mockRecord('a', { added_at: undefined, completed_at: '2024-01-03T00:00:00Z' }),
        mockRecord('b', { added_at: undefined, completed_at: '2024-01-01T00:00:00Z' }),
      ]
      sortRecords(records, 'added-at', 'desc')
      expect(gids(records)).toEqual(['a', 'b'])
    })
  })

  // ── completed-at sorting ──────────────────────────────────────────

  describe('field: completed-at', () => {
    it('sorts DESC — most recently completed first', () => {
      const records = [
        mockRecord('b', { completed_at: '2024-01-01T12:00:00Z' }),
        mockRecord('a', { completed_at: '2024-01-03T12:00:00Z' }),
        mockRecord('c', { completed_at: '2024-01-02T12:00:00Z' }),
      ]
      sortRecords(records, 'completed-at', 'desc')
      expect(gids(records)).toEqual(['a', 'c', 'b'])
    })

    it('sorts ASC — earliest completed first', () => {
      const records = [
        mockRecord('a', { completed_at: '2024-01-03T12:00:00Z' }),
        mockRecord('b', { completed_at: '2024-01-01T12:00:00Z' }),
      ]
      sortRecords(records, 'completed-at', 'asc')
      expect(gids(records)).toEqual(['b', 'a'])
    })

    it('records without completed_at sort to the end in DESC', () => {
      const records = [
        mockRecord('a', { completed_at: undefined }),
        mockRecord('b', { completed_at: '2024-01-01T00:00:00Z' }),
      ]
      sortRecords(records, 'completed-at', 'desc')
      expect(gids(records)).toEqual(['b', 'a'])
    })
  })

  // ── name sorting ──────────────────────────────────────────────────

  describe('field: name', () => {
    it('sorts A-Z (ASC)', () => {
      const records = [
        mockRecord('c', { name: 'zebra.iso' }),
        mockRecord('a', { name: 'alpha.iso' }),
        mockRecord('b', { name: 'mango.iso' }),
      ]
      sortRecords(records, 'name', 'asc')
      expect(gids(records)).toEqual(['a', 'b', 'c'])
    })

    it('sorts Z-A (DESC)', () => {
      const records = [mockRecord('a', { name: 'alpha.iso' }), mockRecord('c', { name: 'zebra.iso' })]
      sortRecords(records, 'name', 'desc')
      expect(gids(records)).toEqual(['c', 'a'])
    })

    it('is case-insensitive', () => {
      const records = [mockRecord('b', { name: 'Banana' }), mockRecord('a', { name: 'apple' })]
      sortRecords(records, 'name', 'asc')
      expect(gids(records)).toEqual(['a', 'b'])
    })
  })

  // ── size sorting ──────────────────────────────────────────────────

  describe('field: size', () => {
    it('sorts largest first (DESC)', () => {
      const records = [
        mockRecord('a', { total_length: 500 }),
        mockRecord('b', { total_length: 2000 }),
        mockRecord('c', { total_length: 100 }),
      ]
      sortRecords(records, 'size', 'desc')
      expect(gids(records)).toEqual(['b', 'a', 'c'])
    })

    it('sorts smallest first (ASC)', () => {
      const records = [mockRecord('b', { total_length: 2000 }), mockRecord('c', { total_length: 100 })]
      sortRecords(records, 'size', 'asc')
      expect(gids(records)).toEqual(['c', 'b'])
    })

    it('treats undefined total_length as 0', () => {
      const records = [mockRecord('a', { total_length: undefined }), mockRecord('b', { total_length: 1000 })]
      sortRecords(records, 'size', 'desc')
      expect(gids(records)).toEqual(['b', 'a'])
    })
  })

  // ── edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty array', () => {
      const records: HistoryRecord[] = []
      sortRecords(records, 'name', 'asc')
      expect(records).toEqual([])
    })

    it('handles single-element array', () => {
      const records = [mockRecord('a')]
      sortRecords(records, 'name', 'asc')
      expect(gids(records)).toEqual(['a'])
    })
  })
})

// ═════════════════════════════════════════════════════════════════════
// Constants and type contracts
// ═════════════════════════════════════════════════════════════════════

describe('sort constants', () => {
  it('ACTIVE_SORT_FIELDS contains exactly 5 fields', () => {
    expect(ACTIVE_SORT_FIELDS).toEqual(['added-at', 'name', 'size', 'progress', 'speed'])
  })

  it('STOPPED_SORT_FIELDS contains exactly 4 fields', () => {
    expect(STOPPED_SORT_FIELDS).toEqual(['added-at', 'completed-at', 'name', 'size'])
  })

  it('ALL_SORT_FIELDS contains exactly 3 fields', () => {
    expect(ALL_SORT_FIELDS).toEqual(['added-at', 'name', 'size'])
  })

  it('DEFAULT_TASK_SORT has valid defaults for all tabs', () => {
    expect(DEFAULT_TASK_SORT).toEqual({
      active: { field: 'added-at', direction: 'desc' },
      stopped: { field: 'added-at', direction: 'desc' },
      all: { field: 'added-at', direction: 'desc' },
    })
  })

  it('DEFAULT_TASK_SORT fields are in their respective field lists', () => {
    expect(ACTIVE_SORT_FIELDS).toContain(DEFAULT_TASK_SORT.active.field)
    expect(STOPPED_SORT_FIELDS).toContain(DEFAULT_TASK_SORT.stopped.field)
    expect(ALL_SORT_FIELDS).toContain(DEFAULT_TASK_SORT.all.field)
  })

  it('ALL_SORT_FIELDS is a subset of ACTIVE_SORT_FIELDS', () => {
    for (const field of ALL_SORT_FIELDS) {
      expect(ACTIVE_SORT_FIELDS).toContain(field)
    }
  })
})
