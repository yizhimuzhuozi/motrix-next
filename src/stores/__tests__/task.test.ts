/** @fileoverview Unit tests for TaskStore with mocked TaskApi. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTaskStore } from '../task'
import type { Aria2Task, Aria2Peer, TaskStatus, HistoryRecord } from '@shared/types'
import { _resetForTesting, registerAddedAt } from '@/composables/useTaskOrder'

// ── Mock history store (DB-primary architecture) ─────────────────────
const mockHistoryFns = {
  init: vi.fn().mockResolvedValue(undefined),
  addRecord: vi.fn().mockResolvedValue(undefined),
  getRecords: vi.fn().mockResolvedValue([] as HistoryRecord[]),
  removeRecord: vi.fn().mockResolvedValue(undefined),
  clearRecords: vi.fn().mockResolvedValue(undefined),
  removeStaleRecords: vi.fn().mockResolvedValue(undefined),
  checkIntegrity: vi.fn().mockResolvedValue('ok'),
  closeConnection: vi.fn().mockResolvedValue(undefined),
  recordTaskBirth: vi.fn().mockResolvedValue(undefined),
  loadBirthRecords: vi.fn().mockResolvedValue([]),
  getSchemaVersion: vi.fn().mockResolvedValue(2),
  removeByInfoHash: vi.fn().mockResolvedValue(undefined),
}
vi.mock('@/stores/history', () => ({
  useHistoryStore: () => mockHistoryFns,
}))

const makeMockTask = (gid: string, status: TaskStatus = 'active', extra: Partial<Aria2Task> = {}): Aria2Task => ({
  gid,
  status,
  totalLength: '1000',
  completedLength: '500',
  uploadLength: '0',
  downloadSpeed: '1000',
  uploadSpeed: '0',
  connections: '1',
  numSeeders: '0',
  dir: '/tmp',
  files: [],
  bittorrent: undefined,
  infoHash: undefined,
  errorCode: undefined,
  errorMessage: undefined,
  numPieces: undefined,
  pieceLength: undefined,
  followedBy: undefined,
  following: undefined,
  belongsTo: undefined,
  ...extra,
})

function createMockApi() {
  return {
    fetchTaskList: vi.fn().mockResolvedValue([makeMockTask('gid1'), makeMockTask('gid2')]),
    fetchTaskItem: vi.fn().mockResolvedValue(makeMockTask('gid1')),
    fetchTaskItemWithPeers: vi.fn().mockResolvedValue({ ...makeMockTask('gid1'), peers: [] as Aria2Peer[] }),
    fetchActiveTaskList: vi.fn().mockResolvedValue([]),
    addUri: vi.fn().mockResolvedValue(['gid3']),
    addUriAtomic: vi.fn().mockResolvedValue('gid3'),
    addTorrent: vi.fn().mockResolvedValue('gid4'),
    addMetalink: vi.fn().mockResolvedValue(['gid5']),
    getOption: vi.fn().mockResolvedValue({}),
    changeOption: vi.fn().mockResolvedValue(undefined),
    getFiles: vi.fn().mockResolvedValue([]),
    removeTask: vi.fn().mockResolvedValue('gid1'),
    forcePauseTask: vi.fn().mockResolvedValue('gid1'),
    pauseTask: vi.fn().mockResolvedValue('gid1'),
    resumeTask: vi.fn().mockResolvedValue('gid1'),
    pauseAllTask: vi.fn().mockResolvedValue('OK'),
    forcePauseAllTask: vi.fn().mockResolvedValue('OK'),
    resumeAllTask: vi.fn().mockResolvedValue('OK'),
    batchResumeTask: vi.fn().mockResolvedValue([]),
    batchPauseTask: vi.fn().mockResolvedValue([]),
    batchForcePauseTask: vi.fn().mockResolvedValue([]),
    batchRemoveTask: vi.fn().mockResolvedValue([]),
    removeTaskRecord: vi.fn().mockResolvedValue('OK'),
    purgeTaskRecord: vi.fn().mockResolvedValue('OK'),
    saveSession: vi.fn().mockResolvedValue('OK'),
  }
}

describe('TaskStore', () => {
  let store: ReturnType<typeof useTaskStore>
  let mockApi: ReturnType<typeof createMockApi>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useTaskStore()
    mockApi = createMockApi()
    store.setApi(mockApi)
    // Reset history mock between tests
    Object.values(mockHistoryFns).forEach((fn) => fn.mockClear())
    mockHistoryFns.getRecords.mockResolvedValue([])
    mockHistoryFns.recordTaskBirth.mockResolvedValue(undefined)
    // Reset in-memory task order state
    _resetForTesting()
  })

  // ─── fetchList ──────────────────────────────────────────

  it('fetchList populates taskList from API', async () => {
    await store.fetchList()
    expect(store.taskList).toHaveLength(2)
    // Active tab sorts by added-at DESC; trackFirstSeen assigns sequential
    // timestamps so gid2 (later) comes before gid1 (earlier).
    expect(store.taskList[0].gid).toBe('gid2')
    expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
  })

  it('fetchList prunes selectedGidList to valid gids only', async () => {
    store.selectTasks(['gid1', 'gid_invalid'])
    await store.fetchList()
    expect(store.selectedGidList).toEqual(['gid1'])
  })

  // ─── fetchList: 'all' branch — 3-source merge ──────────────────

  describe('fetchList all branch', () => {
    beforeEach(() => {
      // Reset mock to avoid interference from the default setup
      mockApi.fetchTaskList.mockReset()
    })

    it('merges active + stopped + history records', async () => {
      await store.changeCurrentList('all')

      // Setup: active returns 1 task, stopped returns 1 task, history returns 1 record
      mockApi.fetchTaskList
        .mockResolvedValueOnce([makeMockTask('aaa', 'active')]) // active
        .mockResolvedValueOnce([makeMockTask('bbb', 'complete')]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        { gid: 'ccc', name: 'old.zip', status: 'complete' } as HistoryRecord,
      ])

      await store.fetchList()

      // All 3 tasks should be present
      expect(store.taskList).toHaveLength(3)
      const gids = store.taskList.map((t: { gid: string }) => t.gid)
      expect(gids).toContain('aaa')
      expect(gids).toContain('bbb')
      expect(gids).toContain('ccc')
    })

    it('deduplicates GIDs: aria2 data takes priority over history', async () => {
      await store.changeCurrentList('all')

      // Same GID 'dup1' exists in both aria2 stopped and history DB
      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active
        .mockResolvedValueOnce([makeMockTask('dup1', 'complete')]) // stopped (aria2)
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        { gid: 'dup1', name: 'history-version.zip', status: 'complete' } as HistoryRecord,
      ])

      await store.fetchList()

      // Only one entry for 'dup1' — aria2 version wins
      expect(store.taskList).toHaveLength(1)
      expect(store.taskList[0].gid).toBe('dup1')
    })

    it('sorts all tasks by added_at DESC regardless of status', async () => {
      // Pre-register birth timestamps to control sort order
      registerAddedAt('active-1', '2024-01-01T10:00:00Z') // oldest
      registerAddedAt('stopped-1', '2024-01-01T10:01:00Z') // middle

      await store.changeCurrentList('all')

      // Live active task + completed stopped task
      mockApi.fetchTaskList
        .mockResolvedValueOnce([makeMockTask('active-1', 'active')]) // active
        .mockResolvedValueOnce([makeMockTask('stopped-1', 'complete')]) // stopped
      // History record with added_at — newest
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        {
          gid: 'hist-1',
          name: 'old.zip',
          status: 'complete',
          added_at: '2024-01-01T10:02:00Z',
        } as HistoryRecord,
      ])

      await store.fetchList()

      const gids = store.taskList.map((t: { gid: string }) => t.gid)
      // Sorted by added_at DESC: hist-1 (newest), stopped-1, active-1 (oldest)
      expect(gids).toEqual(['hist-1', 'stopped-1', 'active-1'])
    })

    it('calls fetchTaskList for active and stopped concurrently', async () => {
      // changeCurrentList('all') internally calls fetchList, so we set up returns for that first
      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active (consumed by changeCurrentList)
        .mockResolvedValueOnce([]) // stopped (consumed by changeCurrentList)
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.changeCurrentList('all')

      // Reset to count only the explicit fetchList call
      mockApi.fetchTaskList.mockReset()
      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active
        .mockResolvedValueOnce([]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      // Should call fetchTaskList twice: once for active, once for stopped
      expect(mockApi.fetchTaskList).toHaveBeenCalledTimes(2)
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith(expect.objectContaining({ type: 'stopped' }))
    })

    it('passes limit for stopped and history queries', async () => {
      await store.changeCurrentList('all')

      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active
        .mockResolvedValueOnce([]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      // The stopped call should have a limit
      const stoppedCall = mockApi.fetchTaskList.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === 'stopped',
      )
      expect(stoppedCall).toBeDefined()
      expect((stoppedCall![0] as { limit?: number }).limit).toBeDefined()
      expect(typeof (stoppedCall![0] as { limit?: number }).limit).toBe('number')

      // History should also be called with a limit
      expect(mockHistoryFns.getRecords).toHaveBeenCalledWith(undefined, expect.any(Number))
    })

    it('handles empty data from all sources gracefully', async () => {
      await store.changeCurrentList('all')

      mockApi.fetchTaskList.mockResolvedValueOnce([]).mockResolvedValueOnce([])
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      expect(store.taskList).toEqual([])
    })

    it('preserves position when task transitions from active to stopped', async () => {
      // Simulate: task 'bbb' completes between polls.
      // Both tasks pre-registered with birth timestamps
      registerAddedAt('bbb', '2024-01-01T10:01:00Z') // added second (newer)
      registerAddedAt('aaa', '2024-01-01T10:00:00Z') // added first (older)

      await store.changeCurrentList('all')

      // Poll 1: both active
      mockApi.fetchTaskList
        .mockResolvedValueOnce([makeMockTask('bbb', 'active'), makeMockTask('aaa', 'active')])
        .mockResolvedValueOnce([])
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()
      const poll1Gids = store.taskList.map((t: { gid: string }) => t.gid)
      // Sorted by added_at DESC: bbb (newer) then aaa (older)
      expect(poll1Gids).toEqual(['bbb', 'aaa'])

      // Poll 2: 'bbb' moved to stopped, 'aaa' still active
      mockApi.fetchTaskList
        .mockResolvedValueOnce([makeMockTask('aaa', 'active')])
        .mockResolvedValueOnce([makeMockTask('bbb', 'complete')])
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()
      const poll2Gids = store.taskList.map((t: { gid: string }) => t.gid)
      // Position unchanged: bbb still before aaa (sorted by added_at)
      expect(poll2Gids).toEqual(['bbb', 'aaa'])
    })

    it('newly tracked tasks (no pre-registered added_at) sort above old DB records', async () => {
      // Edge case: a task appears in aria2 tellStopped before addedAtMap is populated.
      // trackFirstSeen assigns a current timestamp → sorts above old DB records.
      await store.changeCurrentList('all')

      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active
        .mockResolvedValueOnce([makeMockTask('fresh', 'complete')]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        {
          gid: 'old',
          name: 'old.zip',
          status: 'complete',
          added_at: '2024-01-01T00:00:00Z',
        } as HistoryRecord,
      ])

      await store.fetchList()

      const gids = store.taskList.map((t: { gid: string }) => t.gid)
      // 'fresh' gets current time from trackFirstSeen → sorts first
      expect(gids).toEqual(['fresh', 'old'])
    })

    it('filters out completed metadata tasks from the stopped source', async () => {
      await store.changeCurrentList('all')

      // Completed metadata task — should be hidden
      const completedMeta = makeMockTask('meta1', 'complete', {
        followedBy: ['real-gid'],
        files: [
          {
            index: '1',
            path: '[METADATA]KNOPPIX_V9.1',
            length: '26000',
            completedLength: '26000',
            selected: 'true',
            uris: [],
          },
        ],
      })
      const realTask = makeMockTask('real-gid', 'active')

      mockApi.fetchTaskList
        .mockResolvedValueOnce([realTask]) // active — the real download
        .mockResolvedValueOnce([completedMeta]) // stopped — stale metadata
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      // Completed metadata task should be excluded
      expect(store.taskList).toHaveLength(1)
      expect(store.taskList[0].gid).toBe('real-gid')
    })

    it('keeps actively-downloading metadata tasks visible', async () => {
      await store.changeCurrentList('all')

      // Active metadata task — still resolving, must remain visible
      const activeMeta = makeMockTask('meta-active', 'active', {
        files: [
          {
            index: '1',
            path: '[METADATA]KNOPPIX_V9.1CD',
            length: '26000',
            completedLength: '5000',
            selected: 'true',
            uris: [],
          },
        ],
      })

      mockApi.fetchTaskList
        .mockResolvedValueOnce([activeMeta]) // active — metadata still downloading
        .mockResolvedValueOnce([]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      // Active metadata must NOT be filtered — user needs to see the download progress
      expect(store.taskList).toHaveLength(1)
      expect(store.taskList[0].gid).toBe('meta-active')
    })
  })

  it('fetchList prunes selectedGidList to valid gids only', async () => {
    store.selectTasks(['gid1', 'gid_invalid'])
    await store.fetchList()
    expect(store.selectedGidList).toEqual(['gid1'])
  })

  // ─── selectTasks / selectAllTask ────────────────────────

  it('selectAllTask selects all gids in current list', async () => {
    await store.fetchList()
    store.selectAllTask()
    // Order matches added-at DESC sort (gid2 first)
    expect(store.selectedGidList).toEqual(['gid2', 'gid1'])
  })

  it('selectTasks sets arbitrary gid list', () => {
    store.selectTasks(['a', 'b', 'c'])
    expect(store.selectedGidList).toEqual(['a', 'b', 'c'])
  })

  // ─── addUri / addTorrent / addMetalink ──────────────────

  it('addUri calls API and refreshes list', async () => {
    await store.addUri({ uris: ['http://example.com/file.zip'], outs: [], options: {} })
    expect(mockApi.addUri).toHaveBeenCalled()
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('addTorrent calls API, refreshes, and returns gid', async () => {
    const gid = await store.addTorrent({ torrent: 'base64data', options: {} })
    expect(mockApi.addTorrent).toHaveBeenCalledWith({ torrent: 'base64data', options: {} })
    expect(gid).toBe('gid4')
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('addMetalink calls API and refreshes list', async () => {
    await store.addMetalink({ metalink: 'base64data', options: {} })
    expect(mockApi.addMetalink).toHaveBeenCalled()
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  // ─── pauseAllTask / resumeAllTask ───────────────────────

  it('pauseAllTask pauses non-seeding tasks individually via forcePauseTask', async () => {
    // Default mock taskList has 2 active tasks: gid1, gid2
    await store.fetchList()
    await store.pauseAllTask()
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid2' })
    expect(mockApi.forcePauseAllTask).not.toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('pauseAllTask skips seeding tasks', async () => {
    mockApi.fetchTaskList.mockResolvedValueOnce([
      makeMockTask('dl-1', 'active'),
      makeMockTask('seed-1', 'active', {
        bittorrent: { info: { name: 'movie.mkv' } },
        seeder: 'true',
      }),
    ])
    await store.fetchList()
    await store.pauseAllTask()
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'dl-1' })
    expect(mockApi.forcePauseTask).toHaveBeenCalledTimes(1)
    expect(mockApi.forcePauseAllTask).not.toHaveBeenCalled()
  })

  it('resumeAllTask calls API, refreshes, and saves session', async () => {
    await store.resumeAllTask()
    expect(mockApi.resumeAllTask).toHaveBeenCalled()
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  // ─── showTaskDetail / hideTaskDetail ────────────────────

  it('showTaskDetail sets visibility, gid, and current task item', () => {
    const task = makeMockTask('gid1')
    store.showTaskDetail(task)
    expect(store.taskDetailVisible).toBe(true)
    expect(store.currentTaskGid).toBe('gid1')
    expect(store.currentTaskItem?.gid).toBe('gid1')
  })

  it('hideTaskDetail resets visibility', () => {
    store.showTaskDetail(makeMockTask('gid1'))
    store.hideTaskDetail()
    expect(store.taskDetailVisible).toBe(false)
  })

  // ─── changeCurrentList ──────────────────────────────────

  it('changeCurrentList resets list and fetches new type', async () => {
    store.taskList = [makeMockTask('old')]
    await store.changeCurrentList('completed')
    expect(store.currentList).toBe('completed')
    expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'completed' })
  })

  it('changeCurrentList clears selectedGidList', async () => {
    store.selectTasks(['gid1'])
    await store.changeCurrentList('waiting')
    // After reset, selectedGidList is cleared then pruned by fetchList
    expect(store.selectedGidList).toEqual([])
  })

  // ─── removeTask ─────────────────────────────────────────

  it('removeTask calls API and refreshes list', async () => {
    const task = makeMockTask('gid1')
    await store.removeTask(task)
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('removeTask hides detail if removing current detail task', async () => {
    const task = makeMockTask('gid1')
    store.showTaskDetail(task)
    expect(store.taskDetailVisible).toBe(true)
    await store.removeTask(task)
    expect(store.taskDetailVisible).toBe(false)
  })

  it('removeTask always refreshes list even if API throws', async () => {
    mockApi.removeTask.mockRejectedValueOnce(new Error('not found'))
    const task = makeMockTask('gid1')
    await expect(store.removeTask(task)).rejects.toThrow('not found')
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  // ─── pauseTask / resumeTask ─────────────────────────────

  it('pauseTask uses forcePause for BT tasks', async () => {
    const btTask = makeMockTask('gid1', 'active', { bittorrent: { info: { name: 'test' } } })
    await store.pauseTask(btTask)
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.pauseTask).not.toHaveBeenCalled()
  })

  it('pauseTask uses regular pause for HTTP tasks', async () => {
    const httpTask = makeMockTask('gid1')
    await store.pauseTask(httpTask)
    expect(mockApi.pauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.forcePauseTask).not.toHaveBeenCalled()
  })

  it('resumeTask calls API, refreshes, and saves session', async () => {
    const task = makeMockTask('gid1')
    await store.resumeTask(task)
    expect(mockApi.resumeTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  // ─── toggleTask ─────────────────────────────────────────

  it('toggleTask pauses active task', async () => {
    const task = makeMockTask('gid1', 'active')
    await store.toggleTask(task)
    expect(mockApi.pauseTask).toHaveBeenCalled()
  })

  it('toggleTask resumes paused task', async () => {
    const task = makeMockTask('gid1', 'paused')
    await store.toggleTask(task)
    expect(mockApi.resumeTask).toHaveBeenCalled()
  })

  it('toggleTask resumes waiting task', async () => {
    const task = makeMockTask('gid1', 'waiting')
    await store.toggleTask(task)
    expect(mockApi.resumeTask).toHaveBeenCalled()
  })

  // ─── batch operations ───────────────────────────────────

  it('batchRemoveTask calls API with gids and saves session', async () => {
    await store.batchRemoveTask(['gid1', 'gid2'])
    expect(mockApi.batchRemoveTask).toHaveBeenCalledWith({ gids: ['gid1', 'gid2'] })
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('batchPauseSelectedTasks does nothing when selection is empty', async () => {
    store.selectTasks([])
    await store.batchPauseSelectedTasks()
    expect(mockApi.batchPauseTask).not.toHaveBeenCalled()
  })

  it('batchPauseSelectedTasks calls API with selected gids', async () => {
    store.selectTasks(['gid1', 'gid2'])
    await store.batchPauseSelectedTasks()
    expect(mockApi.batchPauseTask).toHaveBeenCalledWith({ gids: ['gid1', 'gid2'] })
  })

  it('batchResumeSelectedTasks does nothing when selection is empty', async () => {
    store.selectTasks([])
    await store.batchResumeSelectedTasks()
    expect(mockApi.batchResumeTask).not.toHaveBeenCalled()
  })

  it('batchResumeSelectedTasks calls API with selected gids', async () => {
    store.selectTasks(['gid1', 'gid2'])
    await store.batchResumeSelectedTasks()
    expect(mockApi.batchResumeTask).toHaveBeenCalledWith({ gids: ['gid1', 'gid2'] })
  })

  // ─── updateCurrentTaskItem ──────────────────────────────

  it('updateCurrentTaskItem sets task, files, and peers', () => {
    const task = makeMockTask('gid1', 'active', {
      files: [{ index: '1', path: '/tmp/f1', length: '100', completedLength: '50', selected: 'true', uris: [] }],
    })
    ;(task as Aria2Task & { peers?: Aria2Peer[] }).peers = [
      {
        peerId: '-qB1234-',
        ip: '1.2.3.4',
        port: '6881',
        bitfield: 'ff',
        amChoking: 'false',
        peerChoking: 'false',
        downloadSpeed: '100',
        uploadSpeed: '0',
        seeder: 'false',
      },
    ]
    store.updateCurrentTaskItem(task)
    expect(store.currentTaskItem?.gid).toBe('gid1')
    expect(store.currentTaskFiles).toHaveLength(1)
  })

  it('updateCurrentTaskItem with null clears all', () => {
    store.showTaskDetail(makeMockTask('gid1'))
    store.updateCurrentTaskItem(null)
    expect(store.currentTaskItem).toBeNull()
    expect(store.currentTaskFiles).toEqual([])
    expect(store.currentTaskPeers).toEqual([])
  })

  // ─── seedingList ────────────────────────────────────────

  it('addToSeedingList adds new gid', () => {
    store.addToSeedingList('gid1')
    expect(store.seedingList).toContain('gid1')
  })

  it('addToSeedingList ignores duplicates', () => {
    store.addToSeedingList('gid1')
    store.addToSeedingList('gid1')
    expect(store.seedingList).toEqual(['gid1'])
  })

  it('removeFromSeedingList removes existing gid', () => {
    store.addToSeedingList('gid1')
    store.addToSeedingList('gid2')
    store.removeFromSeedingList('gid1')
    expect(store.seedingList).toEqual(['gid2'])
  })

  it('removeFromSeedingList ignores non-existent gid', () => {
    store.addToSeedingList('gid1')
    store.removeFromSeedingList('gid999')
    expect(store.seedingList).toEqual(['gid1'])
  })

  // ─── stopSeeding ────────────────────────────────────────

  it('stopSeeding calls forcePause then removeTask then writes DB', async () => {
    const callOrder: string[] = []
    mockApi.forcePauseTask.mockImplementation(() => {
      callOrder.push('forcePause')
      return Promise.resolve('OK')
    })
    mockApi.removeTask.mockImplementation(() => {
      callOrder.push('removeTask')
      return Promise.resolve('OK')
    })

    const task = makeMockTask('gid1', 'active', { bittorrent: { info: { name: 'seed' } }, seeder: 'true' })
    await store.stopSeeding(task)

    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(callOrder).toEqual(['forcePause', 'removeTask'])
    // DB persistence
    expect(mockHistoryFns.addRecord).toHaveBeenCalledWith(expect.objectContaining({ gid: 'gid1', status: 'complete' }))
  })

  it('stopSeeding does not call removeTask if forcePause fails', async () => {
    mockApi.forcePauseTask.mockRejectedValueOnce(new Error('pause failed'))

    const task = makeMockTask('gid1', 'active', { bittorrent: { info: { name: 'x' } }, seeder: 'true' })
    await expect(store.stopSeeding(task)).rejects.toThrow('pause failed')
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.removeTask).not.toHaveBeenCalled()
    expect(mockHistoryFns.addRecord).not.toHaveBeenCalled()
  })

  // ─── stopAllSeeding ─────────────────────────────────────

  it('stopAllSeeding calls two-step stop + DB write for every seeding task', async () => {
    const seeder1 = makeMockTask('s1', 'active', { bittorrent: { info: { name: 'a' } }, seeder: 'true' })
    const seeder2 = makeMockTask('s2', 'active', { bittorrent: { info: { name: 'b' } }, seeder: 'true' })
    store.taskList = [seeder1, seeder2]
    const count = await store.stopAllSeeding()
    expect(count).toBe(2)
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 's1' })
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 's2' })
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 's1' })
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 's2' })
    // Both tasks persisted to DB
    expect(mockHistoryFns.addRecord).toHaveBeenCalledTimes(2)
  })

  it('stopAllSeeding skips non-seeding tasks', async () => {
    const active = makeMockTask('a1', 'active')
    const seeder = makeMockTask('s1', 'active', { bittorrent: { info: { name: 'x' } }, seeder: 'true' })
    store.taskList = [active, seeder]
    const count = await store.stopAllSeeding()
    expect(count).toBe(1)
    expect(mockApi.forcePauseTask).toHaveBeenCalledTimes(1)
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 's1' })
    expect(mockApi.removeTask).toHaveBeenCalledTimes(1)
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 's1' })
  })

  it('stopAllSeeding returns 0 when no seeding tasks exist', async () => {
    store.taskList = [makeMockTask('a1', 'active')]
    const count = await store.stopAllSeeding()
    expect(count).toBe(0)
    expect(mockApi.forcePauseTask).not.toHaveBeenCalled()
    expect(mockApi.removeTask).not.toHaveBeenCalled()
  })

  it('stopAllSeeding continues even if one task fails', async () => {
    const seeder1 = makeMockTask('s1', 'active', { bittorrent: { info: { name: 'a' } }, seeder: 'true' })
    const seeder2 = makeMockTask('s2', 'active', { bittorrent: { info: { name: 'b' } }, seeder: 'true' })
    store.taskList = [seeder1, seeder2]
    mockApi.forcePauseTask.mockRejectedValueOnce(new Error('fail'))
    const count = await store.stopAllSeeding()
    expect(count).toBe(2)
    // Both tasks attempted — s1 failed at forcePause, s2 succeeded with both steps
    expect(mockApi.forcePauseTask).toHaveBeenCalledTimes(2)
  })

  // ─── removeTaskRecord ───────────────────────────────────

  it('removeTaskRecord removes completed task via DB then aria2', async () => {
    const task = makeMockTask('gid1', 'complete')
    await store.removeTaskRecord(task)
    // DB is primary — removeRecord called first
    expect(mockHistoryFns.removeRecord).toHaveBeenCalledWith('gid1')
    // aria2 best-effort cleanup
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'gid1' })
  })

  it('removeTaskRecord removes error task via DB then aria2', async () => {
    const task = makeMockTask('gid1', 'error')
    await store.removeTaskRecord(task)
    expect(mockHistoryFns.removeRecord).toHaveBeenCalledWith('gid1')
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'gid1' })
  })

  it('removeTaskRecord ignores active task', async () => {
    const task = makeMockTask('gid1', 'active')
    await store.removeTaskRecord(task)
    expect(mockHistoryFns.removeRecord).not.toHaveBeenCalled()
    expect(mockApi.removeTaskRecord).not.toHaveBeenCalled()
  })

  it('removeTaskRecord hides detail if removing current detail task', async () => {
    const task = makeMockTask('gid1', 'complete')
    store.showTaskDetail(task)
    await store.removeTaskRecord(task)
    expect(store.taskDetailVisible).toBe(false)
    expect(mockHistoryFns.removeRecord).toHaveBeenCalledWith('gid1')
  })

  it('removeTaskRecord survives aria2 failure (DB-only records)', async () => {
    mockApi.removeTaskRecord.mockRejectedValueOnce(new Error('GID not found'))
    const task = makeMockTask('gid1', 'complete')
    await store.removeTaskRecord(task)
    expect(mockHistoryFns.removeRecord).toHaveBeenCalledWith('gid1')
  })

  // ─── purgeTaskRecord ────────────────────────────────────

  it('purgeTaskRecord clears DB then aria2 and refreshes list', async () => {
    await store.purgeTaskRecord()
    expect(mockHistoryFns.clearRecords).toHaveBeenCalled()
    expect(mockApi.purgeTaskRecord).toHaveBeenCalled()
  })

  it('purgeTaskRecord survives aria2 failure', async () => {
    mockApi.purgeTaskRecord.mockRejectedValueOnce(new Error('RPC fail'))
    await store.purgeTaskRecord()
    expect(mockHistoryFns.clearRecords).toHaveBeenCalled()
  })

  // ─── saveSession ────────────────────────────────────────

  it('saveSession calls API', () => {
    store.saveSession()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })
  // ─── restartTask ───────────────────────────────────────

  it('restartTask submits single URI and removes old record on success', async () => {
    const task = makeMockTask('stopped1', 'error', {
      files: [
        {
          index: '1',
          path: '/tmp/file.zip',
          length: '1000',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/file.zip', status: 'used' }],
        },
      ],
    })
    mockApi.addUriAtomic.mockResolvedValue('new-gid-1')
    mockApi.getOption.mockResolvedValue({ dir: '/tmp' })
    await store.restartTask(task)

    expect(mockApi.addUriAtomic).toHaveBeenCalledTimes(1)
    expect(mockApi.addUriAtomic).toHaveBeenCalledWith({
      uris: ['http://example.com/file.zip'],
      options: { dir: '/tmp' },
    })
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'stopped1' })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('restartTask submits each URI separately for multi-file tasks', async () => {
    const task = makeMockTask('stopped2', 'error', {
      files: [
        {
          index: '1',
          path: '/tmp/a.zip',
          length: '500',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/a.zip', status: 'used' }],
        },
        {
          index: '2',
          path: '/tmp/b.zip',
          length: '500',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/b.zip', status: 'used' }],
        },
      ],
    })
    mockApi.addUriAtomic.mockResolvedValueOnce('new-a').mockResolvedValueOnce('new-b')
    mockApi.getOption.mockResolvedValue({ dir: '/tmp' })
    await store.restartTask(task)

    expect(mockApi.addUriAtomic).toHaveBeenCalledTimes(2)
    expect(mockApi.addUriAtomic).toHaveBeenNthCalledWith(1, {
      uris: ['http://example.com/a.zip'],
      options: { dir: '/tmp' },
    })
    expect(mockApi.addUriAtomic).toHaveBeenNthCalledWith(2, {
      uris: ['http://example.com/b.zip'],
      options: { dir: '/tmp' },
    })
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'stopped2' })
  })

  it('restartTask rolls back created tasks on partial failure', async () => {
    const task = makeMockTask('stopped3', 'error', {
      files: [
        {
          index: '1',
          path: '/tmp/a.zip',
          length: '500',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/a.zip', status: 'used' }],
        },
        {
          index: '2',
          path: '/tmp/b.zip',
          length: '500',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/b.zip', status: 'used' }],
        },
      ],
    })
    // First URI succeeds, second fails
    mockApi.addUriAtomic.mockResolvedValueOnce('new-a').mockRejectedValueOnce(new Error('network error'))

    await expect(store.restartTask(task)).rejects.toThrow('network error')

    // Rollback: the successfully created task should be removed
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 'new-a' })
    // Old record must NOT be deleted since restart failed
    expect(mockApi.removeTaskRecord).not.toHaveBeenCalled()
  })

  it('restartTask skips non-stopped tasks', async () => {
    const task = makeMockTask('active1', 'active')
    await store.restartTask(task)

    expect(mockApi.addUriAtomic).not.toHaveBeenCalled()
    expect(mockApi.removeTaskRecord).not.toHaveBeenCalled()
  })

  // ─── hasActiveTasks ─────────────────────────────────────

  describe('hasActiveTasks', () => {
    it('returns true when active tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('a1', 'active')])
      expect(await store.hasActiveTasks()).toBe(true)
    })

    it('returns true when waiting tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('w1', 'waiting')])
      expect(await store.hasActiveTasks()).toBe(true)
    })

    it('returns false when only paused/completed tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('p1', 'paused'), makeMockTask('c1', 'complete')])
      expect(await store.hasActiveTasks()).toBe(false)
    })

    it('returns false when no tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([])
      expect(await store.hasActiveTasks()).toBe(false)
    })

    it('returns false on API error', async () => {
      mockApi.fetchTaskList.mockRejectedValueOnce(new Error('RPC fail'))
      expect(await store.hasActiveTasks()).toBe(false)
    })

    it('queries globally regardless of current tab', async () => {
      // Switch to completed tab first
      mockApi.fetchTaskList.mockResolvedValue([])
      await store.changeCurrentList('stopped')
      mockApi.fetchTaskList.mockReset()

      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('a1', 'active')])
      expect(await store.hasActiveTasks()).toBe(true)
      // Must query active type, not the current 'stopped' tab
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
    })
  })

  // ─── hasPausedTasks ─────────────────────────────────────

  describe('hasPausedTasks', () => {
    it('returns true when paused tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('p1', 'paused')])
      expect(await store.hasPausedTasks()).toBe(true)
    })

    it('returns false when only active/waiting tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('a1', 'active'), makeMockTask('w1', 'waiting')])
      expect(await store.hasPausedTasks()).toBe(false)
    })

    it('returns false when no tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([])
      expect(await store.hasPausedTasks()).toBe(false)
    })

    it('returns false on API error', async () => {
      mockApi.fetchTaskList.mockRejectedValueOnce(new Error('RPC fail'))
      expect(await store.hasPausedTasks()).toBe(false)
    })

    it('queries globally regardless of current tab', async () => {
      // Switch to completed tab
      mockApi.fetchTaskList.mockResolvedValue([])
      await store.changeCurrentList('stopped')
      mockApi.fetchTaskList.mockReset()

      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('p1', 'paused')])
      expect(await store.hasPausedTasks()).toBe(true)
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
    })
  })

  // NOTE: Task lifecycle scanning (completion + error detection) has been
  // migrated to the app-level useTaskLifecycleService. Tests are in
  // src/composables/__tests__/useTaskLifecycleService.test.ts

  // ── registerTorrentSource / consumeTorrentSource ────────────────────

  describe('torrent source path tracking', () => {
    it('registers and consumes a source path by infoHash', () => {
      store.registerTorrentSource('abc123', '/downloads/movie.torrent')
      expect(store.consumeTorrentSource('abc123')).toBe('/downloads/movie.torrent')
    })

    it('consumeTorrentSource returns undefined for unknown hash', () => {
      expect(store.consumeTorrentSource('nonexistent')).toBeUndefined()
    })

    it('consumeTorrentSource deletes the entry after first consumption', () => {
      store.registerTorrentSource('abc123', '/downloads/movie.torrent')
      store.consumeTorrentSource('abc123')
      expect(store.consumeTorrentSource('abc123')).toBeUndefined()
    })

    it('overwrites previous path when same hash is registered twice', () => {
      store.registerTorrentSource('abc123', '/old/path.torrent')
      store.registerTorrentSource('abc123', '/new/path.torrent')
      expect(store.consumeTorrentSource('abc123')).toBe('/new/path.torrent')
    })

    it('tracks multiple hashes independently', () => {
      store.registerTorrentSource('hash1', '/path/a.torrent')
      store.registerTorrentSource('hash2', '/path/b.torrent')
      expect(store.consumeTorrentSource('hash1')).toBe('/path/a.torrent')
      expect(store.consumeTorrentSource('hash2')).toBe('/path/b.torrent')
    })
  })
})
