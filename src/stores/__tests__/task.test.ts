/** @fileoverview Unit tests for TaskStore with mocked TaskApi. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTaskStore } from '../task'
import type { Aria2Task, Aria2Peer, TaskStatus } from '@shared/types'

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
    addTorrent: vi.fn().mockResolvedValue('gid4'),
    addMetalink: vi.fn().mockResolvedValue(['gid5']),
    getOption: vi.fn().mockResolvedValue({}),
    changeOption: vi.fn().mockResolvedValue(undefined),
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
  })

  // ─── fetchList ──────────────────────────────────────────

  it('fetchList populates taskList from API', async () => {
    await store.fetchList()
    expect(store.taskList).toHaveLength(2)
    expect(store.taskList[0].gid).toBe('gid1')
    expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
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
    expect(store.selectedGidList).toEqual(['gid1', 'gid2'])
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

  it('pauseAllTask falls back to forcePause on error', async () => {
    mockApi.pauseAllTask.mockRejectedValueOnce(new Error('fail'))
    await store.pauseAllTask()
    expect(mockApi.forcePauseAllTask).toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('pauseAllTask calls saveSession after completion', async () => {
    await store.pauseAllTask()
    expect(mockApi.pauseAllTask).toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
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

  it('stopSeeding sets seedTime to 0', async () => {
    await store.stopSeeding('gid1')
    expect(mockApi.changeOption).toHaveBeenCalledWith({ gid: 'gid1', options: { seedTime: '0' } })
  })

  // ─── removeTaskRecord ───────────────────────────────────

  it('removeTaskRecord removes completed task record', async () => {
    const task = makeMockTask('gid1', 'complete')
    await store.removeTaskRecord(task)
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('removeTaskRecord removes error task record', async () => {
    const task = makeMockTask('gid1', 'error')
    await store.removeTaskRecord(task)
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'gid1' })
  })

  it('removeTaskRecord ignores active task', async () => {
    const task = makeMockTask('gid1', 'active')
    await store.removeTaskRecord(task)
    expect(mockApi.removeTaskRecord).not.toHaveBeenCalled()
  })

  it('removeTaskRecord hides detail if removing current detail task', async () => {
    const task = makeMockTask('gid1', 'complete')
    store.showTaskDetail(task)
    await store.removeTaskRecord(task)
    expect(store.taskDetailVisible).toBe(false)
  })

  // ─── purgeTaskRecord ────────────────────────────────────

  it('purgeTaskRecord calls API and refreshes list', async () => {
    await store.purgeTaskRecord()
    expect(mockApi.purgeTaskRecord).toHaveBeenCalled()
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  // ─── saveSession ────────────────────────────────────────

  it('saveSession calls API', () => {
    store.saveSession()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })
})
