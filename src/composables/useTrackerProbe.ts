/**
 * @fileoverview Composable for probing BitTorrent tracker reachability via Rust backend.
 *
 * The Rust `probe_trackers` command probes each URL sequentially and emits
 * a `tracker-probe-result` Tauri event per tracker as soon as it completes.
 * This composable listens for those events to update the UI progressively,
 * rather than blocking until all probes finish.
 */
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { logger } from '@shared/logger'

export type TrackerStatus = 'checking' | 'online' | 'offline' | 'unknown'

export interface TrackerRow {
  url: string
  tier: number
  protocol: string
  status: TrackerStatus
}

/** Payload shape of the `tracker-probe-result` Tauri event. */
interface TrackerProbeEvent {
  url: string
  status: string
}

/**
 * Extracts the protocol scheme from a tracker URL.
 * Exported for unit testing.
 */
export function parseTrackerProtocol(url: string): string {
  const match = url.match(/^(\w+):\/\//)
  return match ? match[1] : 'unknown'
}

/**
 * Builds structured tracker rows from aria2's nested announceList.
 * Each inner array is a tier; URLs within the same tier share a tier index.
 * Exported for unit testing.
 */
export function buildTrackerRows(announceList: string[][] | undefined): TrackerRow[] {
  if (!announceList || announceList.length === 0) return []

  const seen = new Set<string>()
  const rows: TrackerRow[] = []

  announceList.forEach((tierUrls, tierIndex) => {
    for (const url of tierUrls) {
      if (seen.has(url)) continue
      seen.add(url)
      rows.push({
        url,
        tier: tierIndex + 1,
        protocol: parseTrackerProtocol(url),
        status: 'unknown',
      })
    }
  })

  return rows
}

/**
 * Reactive composable that manages tracker probe state.
 *
 * Calls the Rust `probe_trackers` IPC command which probes URLs sequentially
 * and emits a `tracker-probe-result` event for each URL as it completes.
 * The UI updates progressively — each row transitions from "checking" to
 * its final status independently, rather than waiting for all probes to finish.
 */
export function useTrackerProbe() {
  const statuses = ref<Record<string, TrackerStatus>>({})
  const probing = ref(false)
  /** Generation counter to discard results from cancelled or superseded probes. */
  let probeGeneration = 0

  async function probeAll(urls: string[]) {
    const gen = ++probeGeneration
    probing.value = true

    // Mark all URLs as checking before starting
    for (const url of urls) {
      statuses.value[url] = 'checking'
    }

    // Register the event listener BEFORE invoking the command to avoid
    // a race where early results arrive before the listener is ready.
    let unlisten: UnlistenFn | undefined
    try {
      unlisten = await listen<TrackerProbeEvent>('tracker-probe-result', (event) => {
        // Discard if a newer probe or cancel has occurred
        if (gen !== probeGeneration) return
        const { url, status } = event.payload
        statuses.value[url] = status as TrackerStatus
      })

      // invoke() blocks until the Rust command finishes all probes
      await invoke<void>('probe_trackers', { urls })
    } catch (e) {
      logger.debug('TrackerProbe', e)
      if (gen !== probeGeneration) return
      // Mark any remaining "checking" URLs as unknown on error
      for (const url of urls) {
        if (statuses.value[url] === 'checking') {
          statuses.value[url] = 'unknown'
        }
      }
    } finally {
      // Always clean up the event listener to prevent memory leaks
      unlisten?.()
      if (gen === probeGeneration) {
        probing.value = false
      }
    }
  }

  function cancelProbe() {
    probeGeneration++
    for (const url of Object.keys(statuses.value)) {
      if (statuses.value[url] === 'checking') {
        statuses.value[url] = 'unknown'
      }
    }
    probing.value = false
  }

  return { statuses, probing, probeAll, cancelProbe }
}
