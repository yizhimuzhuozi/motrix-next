/** @fileoverview Type declarations for torrent parsing libraries. */
declare module 'parse-torrent' {
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

  export default function parseTorrent(
    torrentId: string | Uint8Array | ArrayBufferView | ParsedTorrent,
  ): Promise<ParsedTorrent>
}

declare module 'bencode' {
  function decode(data: Uint8Array | ArrayBuffer | Buffer | string): Record<string, unknown>
  function encode(data: Record<string, unknown>): Uint8Array
  export default { decode, encode }
}
