/** @fileoverview Download resource detection: Thunder links, protocol tags, copyright. */
import { compact } from 'lodash-es'
import {
  RESOURCE_TAGS,
  BARE_INFO_HASH_RE,
  DETECT_RESOURCE_MAX_CHARS,
  DETECT_RESOURCE_MAX_LINES,
} from '@shared/constants'
import { splitTextRows } from './format'
import { isAudioOrVideo } from './file'
import type { ClipboardConfig } from '@shared/types'

/** Decodes a Thunder (迅雷) protocol link to its original HTTP/FTP URL. */
export const decodeThunderLink = (url = ''): string => {
  if (!url.startsWith('thunder://')) return url
  const trimmed = url.trim()
  const payload = trimmed.slice('thunder://'.length)
  if (!payload) return url

  try {
    const decoded = atob(payload)
    if (!decoded.startsWith('AA') || !decoded.endsWith('ZZ')) return url
    const result = decoded.substring(2, decoded.length - 2)
    return result || url
  } catch {
    return url
  }
}

export const splitTaskLinks = (links = ''): string[] => {
  const temp = compact(splitTextRows(links))
  return temp.map((item) => decodeThunderLink(item))
}

/**
 * Builds the list of allowed protocol prefixes based on a ClipboardConfig filter.
 * When no filter is provided, returns all recognized protocol tags (backward compat).
 */
function buildAllowedTags(filter?: ClipboardConfig): string[] {
  if (!filter) return RESOURCE_TAGS

  const tags: string[] = []
  if (filter.http) {
    tags.push('http://', 'https://')
  }
  if (filter.ftp) {
    tags.push('ftp://')
  }
  if (filter.magnet) {
    tags.push('magnet:')
  }
  if (filter.thunder) {
    tags.push('thunder://')
  }
  return tags
}

/**
 * Returns true if the clipboard content represents downloadable resource(s).
 *
 * Detection rules (all must hold):
 * 1. Content length ≤ 2048 characters (long payloads are not URLs).
 * 2. Split into lines; ignore empty/whitespace-only lines.
 * 3. Every remaining line must start with a recognized protocol tag
 *    (`http://`, `https://`, `ftp://`, `magnet:`, `thunder://`)
 *    OR be a bare BitTorrent v1 info hash (SHA-1 hex / Base32).
 *
 * When a `filter` is provided, only the enabled protocol families are matched.
 * The `enable` master switch short-circuits to false when off.
 *
 * This rejects embedded URLs inside prose, code comments, JSON, HTML,
 * log lines, and mixed multi-line content.
 */
export const detectResource = (content: string, filter?: ClipboardConfig): boolean => {
  if (filter && !filter.enable) return false
  if (!content || content.length > DETECT_RESOURCE_MAX_CHARS) return false

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length === 0 || lines.length > DETECT_RESOURCE_MAX_LINES) return false

  const allowedTags = buildAllowedTags(filter)
  const allowHash = filter ? filter.btHash : true

  return lines.every((line) => {
    const lower = line.toLowerCase()
    return (
      allowedTags.some((tag) => lower.startsWith(tag) && line.length > tag.length) ||
      (allowHash && BARE_INFO_HASH_RE.test(line))
    )
  })
}

export const needCheckCopyright = (links = ''): boolean => {
  const uris = splitTaskLinks(links)
  const avs = uris.filter((uri) => isAudioOrVideo(uri))
  return avs.length > 0
}
