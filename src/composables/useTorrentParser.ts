/** @fileoverview Compatibility wrapper for torrent metadata parsing. */
import { parseTorrentMeta, type TorrentMeta, type TorrentFile } from '@shared/utils/torrentMeta'

export type { TorrentMeta, TorrentFile }

/**
 * Parse a .torrent file (as Uint8Array) into a typed TorrentMeta.
 * Extracts the SHA-1 infoHash and file list. The second parameter is kept
 * for backward-compatible tests/imports from the former bencode adapter.
 */
export async function parseTorrentBuffer(uint8: Uint8Array, _legacyBencode?: unknown): Promise<TorrentMeta | null> {
  return parseTorrentMeta(uint8)
}

/** Converts a Uint8Array to a base64 string for transmission. */
export function uint8ToBase64(uint8: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i])
  }
  return btoa(binary)
}
