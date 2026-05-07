/**
 * @fileoverview Composable for engine restart with concurrency guard.
 *
 * Prevents multiple simultaneous engine restarts — the root cause of orphaned
 * aria2c processes.  Only ONE restart may be in-flight at any time; subsequent
 * calls return `false` immediately.
 *
 * The Rust `restart_engine_command` handles the full lifecycle:
 *   stop → cleanup → start → on_engine_ready (credential update, option sync, service spawn)
 * The frontend only needs to wait for readiness and update the UI state.
 */
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { setEngineReady } from '@/api/aria2'
import { useAppStore } from '@/stores/app'
import { logger } from '@shared/logger'

interface RestartOptions {
  port: number
  secret: string
}

/**
 * Module-level singleton guard — shared across ALL consumers.
 *
 * Previously each useEngineRestart() call created its own ref, meaning
 * concurrent callers from different components (e.g. Advanced.vue AND
 * the crash-recovery watcher) wouldn't see each other's guard state.
 */
const isRestarting = ref(false)

export function useEngineRestart() {
  async function restartEngine(_opts: RestartOptions): Promise<boolean> {
    // Concurrency guard — reject if already restarting
    if (isRestarting.value) {
      logger.debug('useEngineRestart', 'restart already in progress, skipping')
      return false
    }

    isRestarting.value = true
    const appStore = useAppStore()

    // Signal "restarting" to the UI
    appStore.engineReady = false
    appStore.setEngineRestarting(true)
    setEngineReady(false)

    try {
      // Invoke the Rust command (atomic: stop → wait → cleanup → start → on_engine_ready)
      // on_engine_ready handles: credential update, config sync, services spawn
      await invoke('restart_engine_command')

      // Rust-side health check with retries — also updates Aria2Client credentials
      const ready = await invoke<boolean>('wait_for_engine')
      if (ready) {
        appStore.engineReady = true
        setEngineReady(true)
        logger.info('useEngineRestart', 'engine restarted successfully')
        return true
      }

      logger.error('useEngineRestart', 'engine did not become ready after restart')
      appStore.engineReady = false
      return false
    } catch (e) {
      logger.error('useEngineRestart', `restart failed: ${e}`)
      appStore.engineReady = false
      return false
    } finally {
      appStore.setEngineRestarting(false)
      isRestarting.value = false
    }
  }

  return { restartEngine, isRestarting }
}
