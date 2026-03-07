/** @fileoverview Tests for task metadata utilities: progress, naming, BT detection, magnet links. */
import { describe, it, expect } from 'vitest'
import {
  calcProgress,
  calcRatio,
  getTaskName,
  isMagnetTask,
  checkTaskIsBT,
  checkTaskIsSeeder,
  getFileNameFromFile,
  buildMagnetLink,
  getTaskUri,
  checkTaskTitleIsEmpty,
  mergeTaskResult,
} from '../task'
import type { Aria2Task, Aria2File } from '@shared/types'

function createMockTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: '1',
    status: 'active',
    totalLength: '1000',
    completedLength: '500',
    uploadLength: '0',
    downloadSpeed: '100',
    uploadSpeed: '0',
    connections: '1',
    dir: '/tmp',
    files: [],
    ...overrides,
  }
}

function createMockFile(overrides: Partial<Aria2File> = {}): Aria2File {
  return {
    index: '1',
    path: '/tmp/test.txt',
    length: '1000',
    completedLength: '500',
    selected: 'true',
    uris: [],
    ...overrides,
  }
}

describe('calcProgress', () => {
  it('returns 0 for zero total length', () => {
    expect(calcProgress(0, 0)).toBe(0)
  })

  it('calculates percentage correctly', () => {
    expect(calcProgress(1000, 500)).toBe(50)
    expect(calcProgress(1000, 1000)).toBe(100)
    expect(calcProgress(1000, 250)).toBe(25)
  })

  it('respects decimal parameter', () => {
    expect(calcProgress(3, 1, 1)).toBeCloseTo(33.3, 1)
  })

  it('handles string inputs', () => {
    expect(calcProgress('1000', '500')).toBe(50)
  })

  it('returns 0 when completed is 0', () => {
    expect(calcProgress(1000, 0)).toBe(0)
  })
})

describe('calcRatio', () => {
  it('returns 0 for zero total length', () => {
    expect(calcRatio(0, 0)).toBe(0)
  })

  it('calculates ratio correctly', () => {
    expect(calcRatio(1000, 500)).toBe(0.5)
    expect(calcRatio(1000, 1000)).toBe(1)
  })

  it('returns 0 when upload is 0', () => {
    expect(calcRatio(1000, 0)).toBe(0)
  })

  it('handles string inputs', () => {
    expect(calcRatio('1000', '2000')).toBe(2)
  })
})

describe('getTaskName', () => {
  it('returns default name for null task', () => {
    expect(getTaskName(null, { defaultName: 'Unknown' })).toBe('Unknown')
  })

  it('returns empty string for null task with no default', () => {
    expect(getTaskName(null)).toBe('')
  })

  it('returns BT info name when available', () => {
    const task = createMockTask({
      files: [createMockFile()],
      bittorrent: { info: { name: 'My Torrent' } },
    })
    expect(getTaskName(task)).toBe('My Torrent')
  })

  it('returns filename for single-file HTTP task', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/downloads/movie.mp4' })],
    })
    expect(getTaskName(task)).toBe('movie.mp4')
  })

  it('returns default when files array is empty', () => {
    const task = createMockTask({ files: [] })
    expect(getTaskName(task, { defaultName: 'N/A' })).toBe('N/A')
  })

  it('truncates long BT names with ellipsis', () => {
    const task = createMockTask({
      files: [createMockFile()],
      bittorrent: { info: { name: 'A'.repeat(100) } },
    })
    const result = getTaskName(task, { maxLen: 10 })
    expect(result).toBe('A'.repeat(10) + '...')
  })
})

describe('getFileNameFromFile', () => {
  it('returns filename from path', () => {
    const file = createMockFile({ path: '/tmp/download/test.zip' })
    expect(getFileNameFromFile(file)).toBe('test.zip')
  })

  it('returns empty string for undefined file', () => {
    expect(getFileNameFromFile()).toBe('')
  })

  it('falls back to first URI when path is empty', () => {
    const file = createMockFile({
      path: '',
      uris: [{ uri: 'https://example.com/file.zip', status: 'used' }],
    })
    expect(getFileNameFromFile(file)).toBe('file.zip')
  })

  it('returns full path when no separator found', () => {
    const file = createMockFile({ path: 'plainfile.txt' })
    expect(getFileNameFromFile(file)).toBe('plainfile.txt')
  })

  it('returns empty when path and uris are empty', () => {
    const file = createMockFile({ path: '', uris: [] })
    expect(getFileNameFromFile(file)).toBe('')
  })
})

describe('isMagnetTask', () => {
  it('returns true for magnet task without info', () => {
    const task = createMockTask({ bittorrent: {} })
    expect(isMagnetTask(task)).toBe(true)
  })

  it('returns false for regular BT task', () => {
    const task = createMockTask({ bittorrent: { info: { name: 'test' } } })
    expect(isMagnetTask(task)).toBe(false)
  })

  it('returns false for HTTP task', () => {
    const task = createMockTask()
    expect(isMagnetTask(task)).toBe(false)
  })
})

describe('checkTaskIsBT', () => {
  it('returns true when bittorrent metadata is present', () => {
    const task = createMockTask({ bittorrent: { info: { name: 'test' } } })
    expect(checkTaskIsBT(task)).toBe(true)
  })

  it('returns false when no bittorrent metadata', () => {
    expect(checkTaskIsBT(createMockTask())).toBe(false)
  })

  it('returns false for empty object', () => {
    expect(checkTaskIsBT()).toBe(false)
  })
})

describe('checkTaskIsSeeder', () => {
  it('returns true when BT task has seeder=true', () => {
    const task = createMockTask({
      bittorrent: { info: { name: 'test' } },
      seeder: 'true',
    })
    expect(checkTaskIsSeeder(task)).toBe(true)
  })

  it('returns false for non-BT task', () => {
    expect(checkTaskIsSeeder(createMockTask())).toBe(false)
  })

  it('returns false when seeder is false string', () => {
    const task = createMockTask({
      bittorrent: { info: { name: 'test' } },
      seeder: 'false',
    })
    expect(checkTaskIsSeeder(task)).toBe(false)
  })
})

describe('buildMagnetLink', () => {
  it('builds basic magnet link with infoHash', () => {
    const task = createMockTask({ infoHash: 'abc123', bittorrent: {} })
    const result = buildMagnetLink(task)
    expect(result).toBe('magnet:?xt=urn:btih:abc123')
  })

  it('includes display name when BT info has name', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: { info: { name: 'My File' } },
    })
    const result = buildMagnetLink(task)
    expect(result).toContain('dn=My%20File')
  })

  it('includes trackers when withTracker is true', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: {
        info: { name: 'test' },
        announceList: ['http://tracker1.com', 'http://tracker2.com'],
      },
    })
    const result = buildMagnetLink(task, true)
    expect(result).toContain('tr=http://tracker1.com')
    expect(result).toContain('tr=http://tracker2.com')
  })

  it('excludes trackers already in btTracker list', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: {
        info: { name: 'test' },
        announceList: ['http://tracker1.com', 'http://tracker2.com'],
      },
    })
    const result = buildMagnetLink(task, true, ['http://tracker1.com'])
    expect(result).not.toContain('tr=http://tracker1.com')
    expect(result).toContain('tr=http://tracker2.com')
  })

  it('does not include trackers when withTracker is false', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: {
        info: { name: 'test' },
        announceList: ['http://tracker1.com'],
      },
    })
    const result = buildMagnetLink(task, false)
    expect(result).not.toContain('tr=')
  })
})

describe('getTaskUri', () => {
  it('returns magnet link for BT task', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: { info: { name: 'test' } },
      files: [],
    })
    const result = getTaskUri(task)
    expect(result).toContain('magnet:?xt=urn:btih:abc123')
  })

  it('returns first URI for single-file HTTP task', () => {
    const task = createMockTask({
      files: [
        createMockFile({
          uris: [{ uri: 'http://example.com/file.zip', status: 'used' }],
        }),
      ],
    })
    expect(getTaskUri(task)).toBe('http://example.com/file.zip')
  })

  it('returns empty for HTTP task with no URIs', () => {
    const task = createMockTask({
      files: [createMockFile({ uris: [] })],
    })
    expect(getTaskUri(task)).toBe('')
  })

  it('returns empty for multi-file HTTP task', () => {
    const task = createMockTask({
      files: [createMockFile(), createMockFile({ index: '2' })],
    })
    expect(getTaskUri(task)).toBe('')
  })
})

describe('checkTaskTitleIsEmpty', () => {
  it('returns true when path is empty and no BT info', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '' })],
    })
    expect(checkTaskTitleIsEmpty(task)).toBe(true)
  })

  it('returns false when path has value', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/tmp/file.txt' })],
    })
    expect(checkTaskTitleIsEmpty(task)).toBe(false)
  })

  it('returns false when BT info name is present', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '' })],
      bittorrent: { info: { name: 'My Torrent' } },
    })
    expect(checkTaskTitleIsEmpty(task)).toBe(false)
  })

  it('falls through to file path when BT info name is empty', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/tmp/file.txt' })],
      bittorrent: { info: { name: '' } },
    })
    // bittorrent.info.name is falsy (''), so code falls through to file.path
    expect(checkTaskTitleIsEmpty(task)).toBe(false)
  })

  it('uses BT info name when present (non-empty)', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '' })],
      bittorrent: { info: { name: 'My Torrent' } },
    })
    expect(checkTaskTitleIsEmpty(task)).toBe(false)
  })
})

describe('mergeTaskResult', () => {
  it('merges multiple arrays', () => {
    const result = mergeTaskResult([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(result).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns empty for empty input', () => {
    expect(mergeTaskResult([])).toEqual([])
  })

  it('returns empty for default parameter', () => {
    expect(mergeTaskResult()).toEqual([])
  })

  it('handles single nested array', () => {
    expect(mergeTaskResult([['x']])).toEqual(['x'])
  })
})
