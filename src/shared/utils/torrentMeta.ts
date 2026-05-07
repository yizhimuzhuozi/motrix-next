/** @fileoverview Torrent metainfo parsing adapter built on parse-torrent. */
import parseTorrent from 'parse-torrent'

export interface TorrentFile {
  idx: number
  path: string
  length: number
}

export interface TorrentMeta {
  infoHash: string
  files: TorrentFile[]
}

interface ParsedTorrentFile {
  path?: string
  name?: string
  length?: number
}

interface ParsedTorrent {
  infoHash?: string
  name?: string
  files?: ParsedTorrentFile[]
  length?: number
}

function stripRootFolder(path: string, rootName?: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (!rootName) return normalized
  const rootPrefix = `${rootName.replace(/\\/g, '/')}/`
  return normalized.startsWith(rootPrefix) ? normalized.slice(rootPrefix.length) : normalized
}

function toTorrentFiles(parsed: ParsedTorrent): TorrentFile[] {
  const files = parsed.files ?? []
  if (files.length > 0) {
    return files.map((file, index) => ({
      idx: index + 1,
      path: stripRootFolder(file.path || file.name || `file-${index + 1}`, parsed.name),
      length: Number(file.length) || 0,
    }))
  }

  if (!parsed.name) return []
  return [
    {
      idx: 1,
      path: parsed.name,
      length: Number(parsed.length) || 0,
    },
  ]
}

export async function parseTorrentMeta(uint8: Uint8Array): Promise<TorrentMeta | null> {
  try {
    const parsed = (await parseTorrent(uint8)) as ParsedTorrent
    if (!parsed.infoHash) return null
    return {
      infoHash: parsed.infoHash.toLowerCase(),
      files: toTorrentFiles(parsed),
    }
  } catch {
    return null
  }
}

export async function getTorrentInfoHash(uint8: Uint8Array): Promise<string | null> {
  return (await parseTorrentMeta(uint8))?.infoHash ?? null
}
