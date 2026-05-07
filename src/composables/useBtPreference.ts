/**
 * @fileoverview Pure functions for the BitTorrent preference tab.
 *
 * Manages BT-specific config: auto-download content, encryption, seeding,
 * max peers, and tracker management. Key business logic:
 * - btAutoDownloadContent ↔ followTorrent/followMetalink/pauseMetadata
 * - Tracker comma ↔ newline format conversion
 *
 * Tracker source URL validation (isValidTrackerSourceUrl) is co-located
 * here since it is only used in the BT tab's tracker source management.
 */
import type { AppConfig } from '@shared/types'
import { DEFAULT_APP_CONFIG as D } from '@shared/constants'
import { convertCommaToLine, convertLineToComma } from '@shared/utils'

// ── URL Validation ──────────────────────────────────────────────────

/**
 * Validates whether a string is a valid HTTP/HTTPS URL suitable for use as a
 * tracker source. Custom tracker sources are fetched via axios GET, so only
 * HTTP-based protocols are accepted.
 */
export function isValidTrackerSourceUrl(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface BtForm {
  [key: string]: unknown
  btAutoDownloadContent: boolean
  btForceEncryption: boolean
  keepSeeding: boolean
  seedRatio: number
  seedTime: number
  btMaxPeers: number
  trackerSource: string[]
  customTrackerUrls: string[]
  btTracker: string
  autoSyncTracker: boolean
  lastSyncTrackerTime: number
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Builds the BT form state from the preference store config.
 * Merges followTorrent/followMetalink/pauseMetadata into btAutoDownloadContent.
 */
export function buildBtForm(config: AppConfig): BtForm {
  const followTorrent = config.followTorrent ?? D.followTorrent
  const followMetalink = config.followMetalink ?? D.followMetalink
  const pauseMetadata = config.pauseMetadata ?? D.pauseMetadata
  const btAutoDownloadContent = followTorrent && followMetalink && !pauseMetadata

  return {
    btAutoDownloadContent,
    btForceEncryption: config.btForceEncryption ?? D.btForceEncryption,
    keepSeeding: config.keepSeeding ?? D.keepSeeding,
    seedRatio: config.seedRatio ?? D.seedRatio,
    seedTime: config.seedTime ?? D.seedTime,
    btMaxPeers: config.btMaxPeers ?? D.btMaxPeers,
    trackerSource: config.trackerSource ?? [...D.trackerSource],
    customTrackerUrls: config.customTrackerUrls ?? [...D.customTrackerUrls],
    btTracker: convertCommaToLine(config.btTracker ?? D.btTracker),
    autoSyncTracker: config.autoSyncTracker ?? D.autoSyncTracker,
    lastSyncTrackerTime: config.lastSyncTrackerTime ?? D.lastSyncTrackerTime,
  }
}

/**
 * Converts the BT form into aria2 system config key-value pairs.
 * Handles btAutoDownloadContent → follow-torrent/follow-metalink/pause-metadata.
 *
 * IMPORTANT: force-save is intentionally excluded from global config.
 * It must only be set per-download on BT tasks to prevent aria2 from
 * re-downloading completed HTTP tasks on restart.
 */
export function buildBtSystemConfig(f: BtForm): Record<string, string> {
  const autoContent = !!f.btAutoDownloadContent
  return {
    'bt-max-peers': String(f.btMaxPeers),
    'bt-save-metadata': 'true',
    'bt-load-saved-metadata': 'true',
    'bt-force-encryption': String(!!f.btForceEncryption),
    'seed-ratio': String(f.seedRatio),
    'seed-time': String(f.seedTime),
    'keep-seeding': String(!!f.keepSeeding),
    'follow-torrent': String(autoContent),
    'follow-metalink': String(autoContent),
    'pause-metadata': String(!autoContent),
    'bt-tracker': convertLineToComma(f.btTracker),
  }
}

/**
 * Transforms the BT form for store persistence.
 * Expands btAutoDownloadContent back into followTorrent/followMetalink/pauseMetadata.
 * Converts tracker newline format back to comma-separated for storage.
 */
export function transformBtForStore(f: BtForm): Partial<AppConfig> {
  const data = { ...f } as Partial<AppConfig> & Record<string, unknown>

  delete data.btAutoDownloadContent

  if (f.btAutoDownloadContent) {
    data.followTorrent = true
    data.followMetalink = true
    data.pauseMetadata = false
  } else {
    data.followTorrent = false
    data.followMetalink = false
    data.pauseMetadata = true
  }

  data.btTracker = convertLineToComma(f.btTracker)

  return data
}
