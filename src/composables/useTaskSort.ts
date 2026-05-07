/**
 * @fileoverview Per-tab task sorting composable.
 *
 * Provides pure, testable sort functions for the three task tabs:
 *   - Active:  added-at | name | size | progress | speed
 *   - Stopped: added-at | completed-at | name | size
 *   - All:     added-at | name | size
 *
 * Each tab maintains independent sort state (field + direction).
 *
 * Architecture:
 *   sortTasks()   — in-place sort on Aria2Task[] (Active & All tabs)
 *   sortRecords() — in-place sort on HistoryRecord[] (Stopped tab)
 *
 * Both functions are side-effect-free apart from the in-place mutation
 * of the input array (Array.prototype.sort semantics).
 */
import { getTaskName } from '@shared/utils/task'
import type { Aria2Task, HistoryRecord } from '@shared/types'

// ── Sort field types ────────────────────────────────────────────────

export type SortDirection = 'asc' | 'desc'

export type ActiveSortField = 'added-at' | 'name' | 'size' | 'progress' | 'speed'
export type StoppedSortField = 'added-at' | 'completed-at' | 'name' | 'size'
export type AllSortField = 'added-at' | 'name' | 'size'

/** Unified sort configuration persisted in AppConfig. */
export interface TaskSortConfig {
  active: { field: ActiveSortField; direction: SortDirection }
  stopped: { field: StoppedSortField; direction: SortDirection }
  all: { field: AllSortField; direction: SortDirection }
}

// ── Constants ───────────────────────────────────────────────────────

export const ACTIVE_SORT_FIELDS: readonly ActiveSortField[] = ['added-at', 'name', 'size', 'progress', 'speed']

export const STOPPED_SORT_FIELDS: readonly StoppedSortField[] = ['added-at', 'completed-at', 'name', 'size']

export const ALL_SORT_FIELDS: readonly AllSortField[] = ['added-at', 'name', 'size']

export const DEFAULT_TASK_SORT: TaskSortConfig = {
  active: { field: 'added-at', direction: 'desc' },
  stopped: { field: 'added-at', direction: 'desc' },
  all: { field: 'added-at', direction: 'desc' },
}

// ── Internal comparators ────────────────────────────────────────────

/** Compare two string values with direction. Empty strings sort last in DESC. */
function compareStrings(a: string, b: string, dir: SortDirection): number {
  return dir === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
}

/** Compare two numeric values with direction. */
function compareNumbers(a: number, b: number, dir: SortDirection): number {
  return dir === 'asc' ? a - b : b - a
}

// ── Task sort value extractors ──────────────────────────────────────

/** Extract a comparable value from an Aria2Task for the given sort field. */
function taskSortValue(
  task: Aria2Task,
  field: ActiveSortField | AllSortField,
  addedAtIndex: Map<string, string>,
): string | number {
  switch (field) {
    case 'added-at':
      return addedAtIndex.get(task.gid) ?? ''
    case 'name':
      return getTaskName(task).toLowerCase()
    case 'size':
      return Number(task.totalLength) || 0
    case 'progress': {
      const total = Number(task.totalLength) || 0
      return total > 0 ? Number(task.completedLength) / total : 0
    }
    case 'speed':
      return Number(task.downloadSpeed) || 0
  }
}

/** Extract a comparable value from a HistoryRecord for the given sort field. */
function recordSortValue(record: HistoryRecord, field: StoppedSortField): string | number {
  switch (field) {
    case 'added-at':
      return record.added_at ?? record.completed_at ?? ''
    case 'completed-at':
      return record.completed_at ?? ''
    case 'name':
      return record.name.toLowerCase()
    case 'size':
      return record.total_length ?? 0
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Sort an array of Aria2Tasks in-place.
 *
 * Used by Active and All tabs. The `addedAtIndex` map is required for
 * 'added-at' sorting — pass `buildSortableAddedAtMap()` output or an
 * empty Map if using a field that doesn't need it.
 */
export function sortTasks(
  tasks: Aria2Task[],
  field: ActiveSortField | AllSortField,
  direction: SortDirection,
  addedAtIndex: Map<string, string>,
): void {
  tasks.sort((a, b) => {
    const va = taskSortValue(a, field, addedAtIndex)
    const vb = taskSortValue(b, field, addedAtIndex)
    if (typeof va === 'string' && typeof vb === 'string') {
      return compareStrings(va, vb, direction)
    }
    return compareNumbers(va as number, vb as number, direction)
  })
}

/**
 * Sort an array of HistoryRecords in-place.
 *
 * Used by the Stopped tab. Sorting happens in JS (not SQL) for
 * consistency with the Active/All tabs and to support dynamic
 * user-selected sort fields.
 */
export function sortRecords(records: HistoryRecord[], field: StoppedSortField, direction: SortDirection): void {
  records.sort((a, b) => {
    const va = recordSortValue(a, field)
    const vb = recordSortValue(b, field)
    if (typeof va === 'string' && typeof vb === 'string') {
      return compareStrings(va, vb, direction)
    }
    return compareNumbers(va as number, vb as number, direction)
  })
}
