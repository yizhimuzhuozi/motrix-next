/** @fileoverview Torrent metainfo parsing tests. */
import { describe, expect, it } from 'vitest'
import bencode from 'bencode'
import { parseTorrentMeta, getTorrentInfoHash } from '../torrentMeta'

function encodeTorrent(info: Record<string, unknown>): Uint8Array {
  return bencode.encode({
    announce: new TextEncoder().encode('https://tracker.example.com/announce'),
    info,
  })
}

describe('torrentMeta', () => {
  it('parses UTF-8 single-file torrent metadata', async () => {
    const bytes = encodeTorrent({
      name: new TextEncoder().encode('Итоги_2026.docx'),
      length: 42,
      'piece length': 16_384,
      pieces: new Uint8Array(20),
    })

    const meta = await parseTorrentMeta(bytes)

    expect(meta).not.toBeNull()
    expect(meta!.infoHash).toMatch(/^[0-9a-f]{40}$/)
    expect(meta!.files).toEqual([{ idx: 1, path: 'Итоги_2026.docx', length: 42 }])
    await expect(getTorrentInfoHash(bytes)).resolves.toBe(meta!.infoHash)
  })

  it('prefers UTF-8 path fields for multi-file torrents', async () => {
    const bytes = encodeTorrent({
      name: new TextEncoder().encode('fallback-folder'),
      'name.utf-8': new TextEncoder().encode('Документы'),
      files: [
        {
          path: [new TextEncoder().encode('fallback'), new TextEncoder().encode('a.txt')],
          'path.utf-8': [new TextEncoder().encode('Документы'), new TextEncoder().encode('Итоги_2026.docx')],
          length: 1024,
        },
        {
          path: [new TextEncoder().encode('fallback'), new TextEncoder().encode('b.txt')],
          'path.utf-8': [new TextEncoder().encode('Документы'), new TextEncoder().encode('README.md')],
          length: 2048,
        },
      ],
      'piece length': 16_384,
      pieces: new Uint8Array(20),
    })

    const meta = await parseTorrentMeta(bytes)

    expect(meta?.files).toEqual([
      { idx: 1, path: 'Документы/Итоги_2026.docx', length: 1024 },
      { idx: 2, path: 'Документы/README.md', length: 2048 },
    ])
  })

  it('returns null for invalid torrent bytes', async () => {
    await expect(parseTorrentMeta(new TextEncoder().encode('not bencoded'))).resolves.toBeNull()
    await expect(getTorrentInfoHash(new TextEncoder().encode('not bencoded'))).resolves.toBeNull()
  })
})
