/** @fileoverview Unit tests for useTorrentParser composable. */
import { describe, it, expect } from 'vitest'
import bencode from 'bencode'
import { parseTorrentBuffer, uint8ToBase64 } from '../useTorrentParser'

function encodeTorrent(info: Record<string, unknown>): Uint8Array {
  return bencode.encode({
    announce: new TextEncoder().encode('https://tracker.example.com/announce'),
    info,
  })
}

describe('useTorrentParser', () => {
  describe('parseTorrentBuffer', () => {
    it('parses single-file torrent', async () => {
      const torrent = encodeTorrent({
        name: new TextEncoder().encode('test-file.txt'),
        length: 12345,
        'piece length': 16_384,
        pieces: new Uint8Array(20),
      })

      const result = await parseTorrentBuffer(torrent)

      expect(result).not.toBeNull()
      expect(result!.files).toHaveLength(1)
      expect(result!.files[0].path).toBe('test-file.txt')
      expect(result!.files[0].length).toBe(12345)
      expect(result!.infoHash).toMatch(/^[0-9a-f]{40}$/)
    })

    it('parses multi-file torrent', async () => {
      const torrent = encodeTorrent({
        name: new TextEncoder().encode('folder'),
        files: [
          { path: [new TextEncoder().encode('file1.txt')], length: 100 },
          { path: [new TextEncoder().encode('file2.txt')], length: 200 },
        ],
        'piece length': 16_384,
        pieces: new Uint8Array(20),
      })

      const result = await parseTorrentBuffer(torrent)

      expect(result).not.toBeNull()
      expect(result!.files).toHaveLength(2)
      expect(result!.files[0].path).toBe('file1.txt')
      expect(result!.files[1].path).toBe('file2.txt')
      expect(result!.files[0].idx).toBe(1)
      expect(result!.files[1].idx).toBe(2)
    })

    it('returns null when info is missing', async () => {
      const result = await parseTorrentBuffer(bencode.encode({ announce: new Uint8Array([]) }))
      expect(result).toBeNull()
    })
  })

  describe('uint8ToBase64', () => {
    it('converts Uint8Array to base64', () => {
      const input = new TextEncoder().encode('Hello')
      const result = uint8ToBase64(input)
      expect(result).toBe(btoa('Hello'))
    })

    it('handles empty array', () => {
      const result = uint8ToBase64(new Uint8Array([]))
      expect(result).toBe('')
    })
  })
})
