/**
 * @fileoverview Tests for the aria2 API layer (src/api/aria2.ts).
 *
 * Now tests the invoke()-based transport — verifies that each API function
 * calls the correct Tauri command with the expected arguments.
 *
 * Key behaviors under test:
 * - setEngineReady controls the readiness flag
 * - All API methods invoke the correct Tauri command
 * - fetchTaskList routes by type (active vs stopped)
 * - addUri creates one invoke per URI with per-URI output filename override
 * - addUriAtomic creates exactly one invoke with all URIs as mirrors
 * - Batch operations use batch invoke commands
 * - force-save injection for BT/metalink but not HTTP
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ───────────────────────────────────────────────────
const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({}),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import {
  isEngineReady,
  setEngineReady,
  getVersion,
  getGlobalOption,
  getGlobalStat,
  changeGlobalOption,
  getOption,
  changeOption,
  getFiles,
  fetchTaskList,
  fetchTaskItem,
  fetchTaskItemWithPeers,
  fetchActiveTaskList,
  addUri,
  addUriAtomic,
  addTorrent,
  addMetalink,
  removeTask,
  pauseTask,
  resumeTask,
  forcePauseTask,
  pauseAllTask,
  forcePauseAllTask,
  resumeAllTask,
  saveSession,
  removeTaskRecord,
  purgeTaskRecord,
  batchResumeTask,
  batchPauseTask,
  batchRemoveTask,
} from '../aria2'

describe('aria2 API (invoke transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setEngineReady(false)
  })

  // ── Client Lifecycle ────────────────────────────────────────────

  describe('client lifecycle', () => {
    it('setEngineReady explicitly controls readiness flag', () => {
      setEngineReady(true)
      expect(isEngineReady()).toBe(true)
      setEngineReady(false)
      expect(isEngineReady()).toBe(false)
    })
  })

  // ── RPC Method Delegation ───────────────────────────────────────

  describe('RPC methods via invoke', () => {
    beforeEach(async () => {
      setEngineReady(true)
    })

    it('getVersion invokes aria2_get_version', async () => {
      mockInvoke.mockResolvedValueOnce({ version: '1.37.0', enabledFeatures: ['BitTorrent'] })
      const result = await getVersion()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_version')
      expect(result.version).toBe('1.37.0')
    })

    it('getGlobalOption invokes and converts to camelCase', async () => {
      mockInvoke.mockResolvedValueOnce({ 'max-concurrent-downloads': '5' })
      const result = await getGlobalOption()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_global_option')
      expect(result).toHaveProperty('maxConcurrentDownloads')
    })

    it('getGlobalStat invokes aria2_get_global_stat', async () => {
      const stat = {
        downloadSpeed: '0',
        uploadSpeed: '0',
        numActive: '0',
        numStopped: '0',
        numWaiting: '0',
        numStoppedTotal: '0',
      }
      mockInvoke.mockResolvedValueOnce(stat)
      const result = await getGlobalStat()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_global_stat')
      expect(result).toEqual(stat)
    })

    it('changeGlobalOption invokes with formatted options', async () => {
      mockInvoke.mockResolvedValueOnce('OK')
      await changeGlobalOption({ maxConcurrentDownloads: 10 } as never)
      expect(mockInvoke).toHaveBeenCalledWith('aria2_change_global_option', { options: expect.any(Object) })
    })

    it('getOption invokes with gid and converts to camelCase', async () => {
      mockInvoke.mockResolvedValueOnce({ 'max-download-limit': '0' })
      const result = await getOption({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_option', { gid: 'abc' })
      expect(result).toHaveProperty('maxDownloadLimit')
    })

    it('changeOption invokes with gid and formatted options', async () => {
      mockInvoke.mockResolvedValueOnce('OK')
      await changeOption({ gid: 'abc', options: { maxDownloadLimit: '0' } as never })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_change_option', { gid: 'abc', options: expect.any(Object) })
    })

    it('getFiles invokes and returns camelCase typed files', async () => {
      const rawFiles = [
        {
          index: '1',
          path: '/downloads/movie.mkv',
          length: '1500000000',
          'completed-length': '0',
          selected: 'true',
          uris: [{ uri: 'magnet:?xt=urn:btih:abc', status: 'used' }],
        },
        {
          index: '2',
          path: '/downloads/subtitle.srt',
          length: '50000',
          'completed-length': '0',
          selected: 'true',
          uris: [],
        },
      ]
      mockInvoke.mockResolvedValueOnce(rawFiles)
      const result = await getFiles({ gid: 'magnet-gid' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_files', { gid: 'magnet-gid' })
      expect(result).toHaveLength(2)
      expect(result[0].path).toBe('/downloads/movie.mkv')
      expect(result[0].completedLength).toBe('0')
    })
  })

  // ── Task Fetching ───────────────────────────────────────────────

  describe('task fetching', () => {
    beforeEach(async () => {
      setEngineReady(true)
    })

    it('fetchTaskList with type "active" invokes aria2_fetch_task_list', async () => {
      const combined = [
        { gid: '1', status: 'active' },
        { gid: '2', status: 'waiting' },
      ]
      mockInvoke.mockResolvedValueOnce(combined)

      const result = await fetchTaskList({ type: 'active' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_list', { type: 'active', limit: null })
      expect(result).toHaveLength(2)
      expect(result[0].gid).toBe('1')
      expect(result[1].gid).toBe('2')
    })

    it('fetchTaskList with stopped type invokes aria2_fetch_task_list', async () => {
      const stopped = [{ gid: '3', status: 'complete' }]
      mockInvoke.mockResolvedValueOnce(stopped)

      const result = await fetchTaskList({ type: 'complete' })
      expect(result).toHaveLength(1)
    })

    it('fetchActiveTaskList invokes aria2_fetch_active_task_list', async () => {
      mockInvoke.mockResolvedValueOnce([{ gid: '1' }])
      const result = await fetchActiveTaskList()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_active_task_list')
      expect(result).toHaveLength(1)
    })

    it('fetchTaskItem invokes with gid', async () => {
      const task = {
        gid: 'abc',
        status: 'active',
        totalLength: '100',
        completedLength: '50',
        uploadLength: '0',
        downloadSpeed: '0',
        uploadSpeed: '0',
        connections: '1',
        dir: '/dl',
        files: [],
      }
      mockInvoke.mockResolvedValueOnce(task)
      const result = await fetchTaskItem({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_item', { gid: 'abc' })
      expect(result.gid).toBe('abc')
    })

    it('fetchTaskItemWithPeers invokes with gid', async () => {
      const merged = { gid: 'abc', status: 'active', peers: [{ peerId: 'peer1' }] }
      mockInvoke.mockResolvedValueOnce(merged)
      const result = await fetchTaskItemWithPeers({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_item_with_peers', { gid: 'abc' })
      expect(result.gid).toBe('abc')
      expect(result.peers).toHaveLength(1)
    })

    it('fetchTaskList preserves order from Rust response', async () => {
      const tasks = [
        { gid: 'c', status: 'active' },
        { gid: 'a', status: 'active' },
        { gid: 'd', status: 'waiting' },
        { gid: 'b', status: 'waiting' },
      ]
      mockInvoke.mockResolvedValueOnce(tasks)
      const result = await fetchTaskList({ type: 'active' })
      expect(result.map((t) => t.gid)).toEqual(['c', 'a', 'd', 'b'])
    })

    it('fetchTaskList passes limit to invoke', async () => {
      mockInvoke.mockResolvedValueOnce([])
      await fetchTaskList({ type: 'stopped', limit: 128 })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_list', { type: 'stopped', limit: 128 })
    })

    it('fetchTaskList uses null limit when undefined', async () => {
      mockInvoke.mockResolvedValueOnce([])
      await fetchTaskList({ type: 'stopped' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_list', { type: 'stopped', limit: null })
    })
  })

  // ── Task Creation ───────────────────────────────────────────────

  describe('task creation', () => {
    beforeEach(async () => {
      setEngineReady(true)
    })

    it('addUri creates one invoke per URI with per-URI out option', async () => {
      mockInvoke.mockResolvedValue('gid1')

      const result = await addUri({
        uris: ['http://a.com/1.zip', 'http://b.com/2.zip'],
        outs: ['file1.zip', ''],
        options: {},
      })

      expect(result).toHaveLength(2)
      // First call should have out option
      const firstCallArgs = mockInvoke.mock.calls[0]
      expect(firstCallArgs[0]).toBe('aria2_add_uri')
      expect(firstCallArgs[1].options.out).toBe('file1.zip')
    })

    it('addUri decodes RFC 2047 out hints before invoking the backend', async () => {
      mockInvoke.mockResolvedValue('gid1')

      await addUri({
        uris: ['https://mail-attachment.googleusercontent.com/attachment/u/0/'],
        outs: ['=?UTF-8?B?0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4?='],
        options: {},
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['https://mail-attachment.googleusercontent.com/attachment/u/0/'],
        options: { out: 'ИТОГИ ЛДУ 2026.xlsx' },
      })
    })

    it('addUri classifies extensionless downloads by the resolved output filename', async () => {
      mockInvoke.mockResolvedValue('gid1')

      await addUri({
        uris: ['https://mail-attachment.googleusercontent.com/attachment/u/0/'],
        outs: ['ИТОГИ ЛДУ 2026.xlsx'],
        options: { dir: '/downloads' },
        fileCategory: {
          enabled: true,
          categories: [{ label: 'Documents', extensions: ['xlsx'], directory: '/downloads/Documents' }],
        },
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['https://mail-attachment.googleusercontent.com/attachment/u/0/'],
        options: { dir: '/downloads/Documents', out: 'ИТОГИ ЛДУ 2026.xlsx' },
      })
    })

    it('addUriAtomic creates exactly one invoke with all URIs', async () => {
      mockInvoke.mockResolvedValueOnce('gid-atomic')

      const result = await addUriAtomic({
        uris: ['http://mirror1.com/f.zip', 'http://mirror2.com/f.zip'],
        options: {},
      })

      expect(result).toBe('gid-atomic')
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['http://mirror1.com/f.zip', 'http://mirror2.com/f.zip'],
        options: expect.any(Object),
      })
    })

    it('addTorrent passes base64 torrent data', async () => {
      mockInvoke.mockResolvedValueOnce('gid-torrent')
      const result = await addTorrent({ torrent: 'base64data', options: {} })
      expect(result).toBe('gid-torrent')
      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_torrent', {
        torrent: 'base64data',
        options: expect.objectContaining({ 'force-save': 'true' }),
      })
    })

    it('addMetalink passes base64 metalink data', async () => {
      mockInvoke.mockResolvedValueOnce(['gid-ml1'])
      const result = await addMetalink({ metalink: 'base64ml', options: {} })
      expect(result).toEqual(['gid-ml1'])
      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_metalink', {
        metalink: 'base64ml',
        options: expect.objectContaining({ 'force-save': 'true' }),
      })
    })

    it('addTorrent injects force-save=true into per-download options', async () => {
      mockInvoke.mockResolvedValueOnce('gid-torrent')
      await addTorrent({ torrent: 'base64data', options: {} })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      expect((callArgs.options as Record<string, string>)['force-save']).toBe('true')
    })

    it('addTorrent preserves caller-supplied options alongside force-save', async () => {
      mockInvoke.mockResolvedValueOnce('gid-torrent')
      await addTorrent({ torrent: 'data', options: { dir: '/custom', split: '4' } })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      const options = callArgs.options as Record<string, string>
      expect(options['force-save']).toBe('true')
      expect(options.dir).toBe('/custom')
      expect(options.split).toBe('4')
    })

    it('addMetalink injects force-save=true', async () => {
      mockInvoke.mockResolvedValueOnce(['gid-ml1'])
      await addMetalink({ metalink: 'base64ml', options: {} })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      expect((callArgs.options as Record<string, string>)['force-save']).toBe('true')
    })

    it('addUri does NOT inject force-save (HTTP downloads must not persist)', async () => {
      mockInvoke.mockResolvedValue('gid-http')
      await addUri({ uris: ['http://example.com/file.zip'], outs: [], options: {} })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      expect((callArgs.options as Record<string, string>)['force-save']).toBeUndefined()
    })

    it('addUriAtomic does NOT inject force-save', async () => {
      mockInvoke.mockResolvedValueOnce('gid-atomic')
      await addUriAtomic({ uris: ['http://example.com/f.zip'], options: {} })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      expect((callArgs.options as Record<string, string>)['force-save']).toBeUndefined()
    })
  })

  // ── Task Control ────────────────────────────────────────────────

  describe('task control', () => {
    beforeEach(async () => {
      setEngineReady(true)
      mockInvoke.mockResolvedValue('OK')
    })

    it('removeTask invokes aria2_force_remove', async () => {
      await removeTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_force_remove', { gid: 'abc' })
    })

    it('pauseTask invokes aria2_pause', async () => {
      await pauseTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_pause', { gid: 'abc' })
    })

    it('forcePauseTask invokes aria2_force_pause', async () => {
      await forcePauseTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_force_pause', { gid: 'abc' })
    })

    it('resumeTask invokes aria2_unpause', async () => {
      await resumeTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_unpause', { gid: 'abc' })
    })

    it('pauseAllTask invokes aria2_pause_all', async () => {
      await pauseAllTask()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_pause_all')
    })

    it('forcePauseAllTask invokes aria2_force_pause_all', async () => {
      await forcePauseAllTask()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_force_pause_all')
    })

    it('resumeAllTask invokes aria2_unpause_all', async () => {
      await resumeAllTask()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_unpause_all')
    })

    it('saveSession invokes aria2_save_session', async () => {
      await saveSession()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_save_session')
    })

    it('removeTaskRecord invokes aria2_remove_download_result', async () => {
      await removeTaskRecord({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_remove_download_result', { gid: 'abc' })
    })

    it('purgeTaskRecord invokes aria2_purge_download_result', async () => {
      await purgeTaskRecord()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_purge_download_result')
    })
  })

  // ── Batch Operations ────────────────────────────────────────────

  describe('batch operations', () => {
    beforeEach(async () => {
      setEngineReady(true)
      mockInvoke.mockResolvedValue([['OK'], ['OK']])
    })

    it('batchResumeTask invokes aria2_batch_unpause with gids', async () => {
      await batchResumeTask({ gids: ['g1', 'g2'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_unpause', { gids: ['g1', 'g2'] })
    })

    it('batchPauseTask invokes aria2_batch_force_pause with gids', async () => {
      await batchPauseTask({ gids: ['g1', 'g2'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_force_pause', { gids: ['g1', 'g2'] })
    })

    it('batchRemoveTask invokes aria2_batch_force_remove with gids', async () => {
      await batchRemoveTask({ gids: ['g1'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_force_remove', { gids: ['g1'] })
    })
  })
})
