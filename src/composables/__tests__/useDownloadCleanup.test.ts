/** @fileoverview TDD tests for stale record detection and torrent cleanup utilities. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCheckPathExists = vi.fn()
const mockRemove = vi.fn()
const mockReadDir = vi.fn()
const mockReadFile = vi.fn()
const mockTrashFile = vi.fn()
const mockRemoveFile = vi.fn()

vi.mock('@tauri-apps/plugin-fs', () => ({
  remove: (...args: unknown[]) => mockRemove(...args),
  readDir: (...args: unknown[]) => mockReadDir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

// Mock Tauri path — join uses OS-native separator, mock with /
vi.mock('@tauri-apps/api/path', () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
}))

// Mock invoke — routes filesystem-sensitive operations through Rust IPC.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'check_path_exists') return mockCheckPathExists(args)
    if (cmd === 'trash_file') return mockTrashFile(args)
    if (cmd === 'remove_file') return mockRemoveFile(args)
    if (cmd === 'read_local_file') return mockReadFile(args?.path)
    if (cmd === 'list_dir_files') {
      const entries = await mockReadDir(args)
      return entries.filter((entry: { isFile?: boolean }) => entry.isFile).map((entry: { name: string }) => entry.name)
    }
    return Promise.reject(new Error(`Unexpected invoke: ${cmd}`))
  },
}))

const {
  findStaleRecords,
  trashTorrentFile,
  shouldDeleteTorrent,
  cleanupTorrentMetadataFiles,
  cleanupAria2MetadataFiles,
} = await import('../useDownloadCleanup')

describe('useDownloadCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── findStaleRecords ────────────────────────────────────────────

  describe('findStaleRecords', () => {
    it('returns GIDs of records whose files do not exist', async () => {
      mockCheckPathExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false)

      const records = [
        { gid: 'g1', dir: '/dl', name: 'exists.zip' },
        { gid: 'g2', dir: '/dl', name: 'gone.zip' },
        { gid: 'g3', dir: '/dl', name: 'deleted.zip' },
      ]

      const stale = await findStaleRecords(records)
      expect(stale).toEqual(['g2', 'g3'])
    })

    it('returns empty array when all files exist', async () => {
      mockCheckPathExists.mockResolvedValue(true)

      const records = [
        { gid: 'g1', dir: '/dl', name: 'a.zip' },
        { gid: 'g2', dir: '/dl', name: 'b.zip' },
      ]

      const stale = await findStaleRecords(records)
      expect(stale).toEqual([])
    })

    it('handles empty input', async () => {
      const stale = await findStaleRecords([])
      expect(stale).toEqual([])
    })

    it('skips records with missing dir or name', async () => {
      mockCheckPathExists.mockResolvedValue(true)

      const records = [
        { gid: 'g1', dir: '', name: 'a.zip' },
        { gid: 'g2', dir: '/dl', name: '' },
        { gid: 'g3', dir: '/dl', name: 'valid.zip' },
      ]

      const stale = await findStaleRecords(records)
      // g1 and g2 should be treated as stale (can't verify file existence)
      expect(stale).toContain('g1')
      expect(stale).toContain('g2')
      expect(stale).not.toContain('g3')
    })

    it('marks multi-file record as stale only when ALL files are gone', async () => {
      // File 1 exists, file 2 gone — should NOT be stale
      mockCheckPathExists.mockResolvedValueOnce(true) // /dl/a.zip exists
      const records = [{ gid: 'g1', dir: '/dl', name: 'a.zip', filePaths: ['/dl/a.zip', '/dl/b.zip'] }]
      const stale = await findStaleRecords(records)
      expect(stale).not.toContain('g1')
    })

    it('marks multi-file record as stale when ALL files are gone', async () => {
      mockCheckPathExists
        .mockResolvedValueOnce(false) // /dl/a.zip gone
        .mockResolvedValueOnce(false) // /dl/b.zip gone
      const records = [{ gid: 'g1', dir: '/dl', name: 'a.zip', filePaths: ['/dl/a.zip', '/dl/b.zip'] }]
      const stale = await findStaleRecords(records)
      expect(stale).toContain('g1')
    })

    it('uses legacy single-file check when filePaths is absent', async () => {
      mockCheckPathExists.mockResolvedValueOnce(false) // single file gone
      const records = [
        { gid: 'g1', dir: '/dl', name: 'a.zip' }, // no filePaths
      ]
      const stale = await findStaleRecords(records)
      expect(stale).toContain('g1')
    })
  })

  // ── trashTorrentFile ────────────────────────────────────────────

  describe('trashTorrentFile', () => {
    it('trashes a torrent file that exists', async () => {
      mockCheckPathExists.mockResolvedValue(true)
      mockTrashFile.mockResolvedValue(undefined)

      const result = await trashTorrentFile('/downloads/movie.torrent')
      expect(result).toBe(true)
      expect(mockTrashFile).toHaveBeenCalledWith({ path: '/downloads/movie.torrent' })
    })

    it('returns false when file does not exist', async () => {
      mockCheckPathExists.mockResolvedValue(false)

      const result = await trashTorrentFile('/downloads/gone.torrent')
      expect(result).toBe(false)
      expect(mockTrashFile).not.toHaveBeenCalled()
    })

    it('returns false on error and does not throw', async () => {
      mockCheckPathExists.mockResolvedValue(true)
      mockTrashFile.mockRejectedValue(new Error('perm denied'))

      const result = await trashTorrentFile('/downloads/locked.torrent')
      expect(result).toBe(false)
    })

    it('returns false for empty path', async () => {
      const result = await trashTorrentFile('')
      expect(result).toBe(false)
    })
  })

  // ── shouldDeleteTorrent ─────────────────────────────────────────

  describe('shouldDeleteTorrent', () => {
    it('returns true when setting is enabled', () => {
      expect(shouldDeleteTorrent({ deleteTorrentAfterComplete: true })).toBe(true)
    })

    it('returns false when setting is disabled', () => {
      expect(shouldDeleteTorrent({ deleteTorrentAfterComplete: false })).toBe(false)
    })

    it('returns false when setting is undefined', () => {
      expect(shouldDeleteTorrent({})).toBe(false)
    })
  })

  // ── cleanupTorrentMetadataFiles ─────────────────────────────────

  describe('cleanupTorrentMetadataFiles', () => {
    // Helper: build a DirEntry with isFile=true
    const fileEntry = (name: string) => ({ name, isFile: true, isDirectory: false, isSymlink: false })
    const dirEntry = (name: string) => ({ name, isFile: false, isDirectory: true, isSymlink: false })

    it('returns false when dir is empty', async () => {
      expect(await cleanupTorrentMetadataFiles('', 'abc123')).toBe(false)
    })

    it('returns false when infoHash is empty', async () => {
      expect(await cleanupTorrentMetadataFiles('/dl', '')).toBe(false)
    })

    it('returns false when no .torrent files in dir', async () => {
      mockReadDir.mockResolvedValue([fileEntry('movie.mkv'), fileEntry('readme.txt')])

      const result = await cleanupTorrentMetadataFiles('/dl', 'deadbeef')
      expect(result).toBe(false)
      expect(mockTrashFile).not.toHaveBeenCalled()
    })

    it('ignores user-named .torrent files (non-hex40 names)', async () => {
      mockReadDir.mockResolvedValue([fileEntry('Ubuntu.torrent'), fileEntry('my-download.torrent')])

      const result = await cleanupTorrentMetadataFiles('/dl', 'deadbeef')
      expect(result).toBe(false)
      expect(mockRemove).not.toHaveBeenCalled()
      expect(mockTrashFile).not.toHaveBeenCalled()
    })

    it('ignores directories even if named like hex40.torrent', async () => {
      mockReadDir.mockResolvedValue([dirEntry('a'.repeat(40) + '.torrent')])

      const result = await cleanupTorrentMetadataFiles('/dl', 'deadbeef')
      expect(result).toBe(false)
      expect(mockReadFile).not.toHaveBeenCalled()
    })

    it('deletes the matching .torrent file when infoHash matches', async () => {
      const hexName = 'abcdef1234567890abcdef1234567890abcdef12'
      mockReadDir.mockResolvedValue([fileEntry(hexName + '.torrent')])

      // Mock readFile to return torrent bytes and parseTorrent to match
      // We need to mock the internal parseTorrentForCleanup call.
      // Since it's imported within the module, we pass a mock hashExtractor.
      // Actually, the function uses its own internal parser. Let me check the actual implementation approach.

      // The simplest approach: the function takes a hashExtractor callback for testability.
      // This is consistent with the DI pattern used throughout the codebase.
      const extractor = vi.fn().mockResolvedValue('e2345c99159456342ce6f4ec830ec08fc2e9fc7f')
      mockCheckPathExists.mockResolvedValue(true)
      mockRemoveFile.mockResolvedValue(undefined)

      const result = await cleanupTorrentMetadataFiles('/dl', 'e2345c99159456342ce6f4ec830ec08fc2e9fc7f', extractor)
      expect(result).toBe(true)
      expect(extractor).toHaveBeenCalledWith('/dl/' + hexName + '.torrent')
      expect(mockRemoveFile).toHaveBeenCalledWith({ path: '/dl/' + hexName + '.torrent' })
    })

    it('skips .torrent files whose infoHash does not match', async () => {
      const hexName = 'abcdef1234567890abcdef1234567890abcdef12'
      mockReadDir.mockResolvedValue([fileEntry(hexName + '.torrent')])

      const extractor = vi.fn().mockResolvedValue('different_hash_value_that_does_not_match')
      mockRemove.mockResolvedValue(undefined)

      const result = await cleanupTorrentMetadataFiles('/dl', 'e2345c99159456342ce6f4ec830ec08fc2e9fc7f', extractor)
      expect(result).toBe(false)
      expect(mockRemoveFile).not.toHaveBeenCalled()
    })

    it('handles multiple candidates and deletes only the match', async () => {
      const hex1 = '1111111111111111111111111111111111111111'
      const hex2 = '2222222222222222222222222222222222222222'
      const hex3 = '3333333333333333333333333333333333333333'
      mockReadDir.mockResolvedValue([
        fileEntry(hex1 + '.torrent'),
        fileEntry(hex2 + '.torrent'),
        fileEntry(hex3 + '.torrent'),
      ])

      const targetHash = 'aabbccdd11223344aabbccdd11223344aabbccdd'
      const extractor = vi
        .fn()
        .mockResolvedValueOnce('wrong_hash_1')
        .mockResolvedValueOnce(targetHash) // match on second file
        .mockResolvedValueOnce('wrong_hash_3')

      mockCheckPathExists.mockResolvedValue(true)
      mockRemoveFile.mockResolvedValue(undefined)

      const result = await cleanupTorrentMetadataFiles('/dl', targetHash, extractor)
      expect(result).toBe(true)
      // Should have stopped after finding the match (second file)
      expect(extractor).toHaveBeenCalledTimes(2)
      expect(mockRemoveFile).toHaveBeenCalledTimes(1)
      expect(mockRemoveFile).toHaveBeenCalledWith({ path: '/dl/' + hex2 + '.torrent' })
    })

    it('survives readDir failure gracefully', async () => {
      mockReadDir.mockRejectedValue(new Error('access denied'))

      const result = await cleanupTorrentMetadataFiles('/dl', 'abc123')
      expect(result).toBe(false)
    })

    it('survives hash extractor failure for one file and continues', async () => {
      const hex1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const hex2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      mockReadDir.mockResolvedValue([fileEntry(hex1 + '.torrent'), fileEntry(hex2 + '.torrent')])

      const targetHash = 'target_hash_value'
      const extractor = vi
        .fn()
        .mockRejectedValueOnce(new Error('parse failed')) // first file fails
        .mockResolvedValueOnce(targetHash) // second file matches

      mockCheckPathExists.mockResolvedValue(true)
      mockRemoveFile.mockResolvedValue(undefined)

      const result = await cleanupTorrentMetadataFiles('/dl', targetHash, extractor)
      expect(result).toBe(true)
      expect(mockRemoveFile).toHaveBeenCalledWith({ path: '/dl/' + hex2 + '.torrent' })
    })

    it('survives remove failure gracefully', async () => {
      const hexName = 'cccccccccccccccccccccccccccccccccccccccc'
      mockReadDir.mockResolvedValue([fileEntry(hexName + '.torrent')])

      const extractor = vi.fn().mockResolvedValue('target')
      mockCheckPathExists.mockResolvedValue(true)
      mockRemoveFile.mockRejectedValue(new Error('perm denied'))

      const result = await cleanupTorrentMetadataFiles('/dl', 'target', extractor)
      expect(result).toBe(false)
    })

    it('handles mixed file types: only processes hex40.torrent files', async () => {
      mockReadDir.mockResolvedValue([
        fileEntry('movie.mkv'),
        fileEntry('Ubuntu.torrent'), // user file — skip
        dirEntry('data'), // directory — skip
        fileEntry('abcdef1234567890abcdef1234567890abcdef12.torrent'), // ← candidate
        fileEntry('ABCDEF1234567890ABCDEF1234567890ABCDEF12.torrent'), // uppercase — not hex40 lowercase
      ])

      const extractor = vi.fn().mockResolvedValue('matchhash')
      mockCheckPathExists.mockResolvedValue(true)
      mockRemoveFile.mockResolvedValue(undefined)

      const result = await cleanupTorrentMetadataFiles('/dl', 'matchhash', extractor)
      expect(result).toBe(true)
      // Only the lowercase hex40 candidate should be processed
      expect(extractor).toHaveBeenCalledTimes(1)
    })
  })

  // ── cleanupAria2MetadataFiles ──────────────────────────────────────
  // Renamed function that replaces cleanupTorrentMetadataFiles with:
  // - Extended regex to also match .meta4 files
  // - Uses removePath (permanent delete) instead of trashPath
  // - Backward compatible export alias

  describe('cleanupAria2MetadataFiles', () => {
    const fileEntry = (name: string) => ({ name, isFile: true, isDirectory: false, isSymlink: false })

    beforeEach(() => {
      vi.clearAllMocks()
      mockCheckPathExists.mockResolvedValue(true)
      mockRemoveFile.mockResolvedValue(undefined)
    })

    it('uses removePath (remove_file) instead of trashPath for hex40 .torrent', async () => {
      const hexName = 'abcdef1234567890abcdef1234567890abcdef12'
      mockReadDir.mockResolvedValue([fileEntry(hexName + '.torrent')])
      const extractor = vi.fn().mockResolvedValue('target_hash')

      await cleanupAria2MetadataFiles('/dl', 'target_hash', extractor)

      expect(mockRemoveFile).toHaveBeenCalledWith({ path: '/dl/' + hexName + '.torrent' })
      expect(mockTrashFile).not.toHaveBeenCalled()
    })

    it('matches and removes hex40 .meta4 files', async () => {
      const hexName = 'abcdef1234567890abcdef1234567890abcdef12'
      mockReadDir.mockResolvedValue([fileEntry(hexName + '.meta4')])

      await cleanupAria2MetadataFiles('/dl', 'any_hash')

      // .meta4 files are always removed (no infoHash inside to parse)
      expect(mockRemoveFile).toHaveBeenCalledWith({ path: '/dl/' + hexName + '.meta4' })
    })

    it('processes both .torrent and .meta4 candidates in same directory', async () => {
      const hex1 = '1111111111111111111111111111111111111111'
      const hex2 = '2222222222222222222222222222222222222222'
      mockReadDir.mockResolvedValue([fileEntry(hex1 + '.meta4'), fileEntry(hex2 + '.torrent')])
      const extractor = vi.fn().mockResolvedValue('target_hash')

      await cleanupAria2MetadataFiles('/dl', 'target_hash', extractor)

      // .meta4 removed unconditionally
      expect(mockRemoveFile).toHaveBeenCalledWith({ path: '/dl/' + hex1 + '.meta4' })
      // .torrent removed because infoHash matched
      expect(mockRemoveFile).toHaveBeenCalledWith({ path: '/dl/' + hex2 + '.torrent' })
    })

    it('does NOT match non-hex40 .meta4 files', async () => {
      mockReadDir.mockResolvedValue([
        fileEntry('my-download.meta4'), // user file
        fileEntry('short.meta4'),
      ])

      await cleanupAria2MetadataFiles('/dl', 'hash')

      expect(mockRemoveFile).not.toHaveBeenCalled()
    })

    it('is backward-compatible with cleanupTorrentMetadataFiles alias', () => {
      // Verify both names point to the same function
      expect(cleanupAria2MetadataFiles).toBe(cleanupTorrentMetadataFiles)
    })

    it('returns false for empty dir or infoHash', async () => {
      expect(await cleanupAria2MetadataFiles('', 'hash')).toBe(false)
      expect(await cleanupAria2MetadataFiles('/dl', '')).toBe(false)
    })
  })
})
