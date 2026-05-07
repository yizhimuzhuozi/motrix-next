/** @fileoverview Application entry point: mounts Vue, initializes i18n, aria2 engine, and IPC listeners. */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import { i18n } from '@/composables/useLocale'
import { setI18nLocale } from '@shared/utils/i18n'
import { usePreferenceStore } from './stores/preference'
import { useTaskStore } from './stores/task'
import { useAppStore } from './stores/app'
import { useHistoryStore } from './stores/history'
import aria2Api from './api/aria2'
import { ENGINE_RPC_PORT, AUTO_SYNC_TRACKER_INTERVAL, DEFAULT_TRACKER_SOURCE } from '@shared/constants'
import { convertTrackerDataToLine, convertTrackerDataToComma, reduceTrackerString } from '@shared/utils/tracker'
import { logger } from '@shared/logger'
import type { AppConfig, TauriUpdate } from '@shared/types'
import App from './App.vue'
import 'virtual:uno.css'
import './styles/variables.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { getLocale } from 'tauri-plugin-locale-api'
import { resolveSystemLocale } from '@shared/utils/locale'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(i18n)

// ── Production guard: suppress browser default context menu ─────────
// In dev mode, keep the context menu for DevTools / Inspect Element.
// Industry standard for Tauri/Electron desktop apps (Discord, Slack, VS Code).
if (import.meta.env.PROD) {
  document.addEventListener('contextmenu', (e) => e.preventDefault())
}

app.mount('#app')

// ── Global error boundary — catch all uncaught exceptions to log file ──
// Registered after mount (UI renders first) but before init block (covers
// all async code paths: deep-link, clipboard, engine, tracker sync).
window.addEventListener('error', (e) => {
  logger.error('GlobalError', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  logger.error('UnhandledRejection', e.reason)
})

// ── Main window initialization ──────────────────────────────────────

{
  const preferenceStore = usePreferenceStore()
  const taskStore = useTaskStore()
  const appStore = useAppStore()
  const historyStore = useHistoryStore()

  /** Rust-side health check: probes aria2c HTTP RPC with retries.
   *  Also updates Aria2Client credentials so invoke() commands work. */
  async function waitForEngine(): Promise<boolean> {
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      return await invoke<boolean>('wait_for_engine')
    } catch (e) {
      logger.error('waitForEngine', `invoke failed: ${e}`)
      return false
    }
  }

  async function autoCheckForUpdate() {
    const config = preferenceStore.config
    if (config.autoCheckUpdate === false) return

    const intervalHours = Number(config.autoCheckUpdateInterval ?? 0)
    if (Number.isFinite(intervalHours) && intervalHours > 0) {
      const lastCheck = Number(config.lastCheckUpdateTime) || 0
      const intervalMs = intervalHours * 3_600_000
      if (Date.now() - lastCheck < intervalMs) return
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const channel = config.updateChannel || 'stable'
      const proxy = config.proxy
      const proxyServer =
        proxy?.enable && proxy.server && (proxy.scope || []).includes('update-app') ? proxy.server : null
      const update = await invoke<TauriUpdate | null>('check_for_update', { channel, proxy: proxyServer })
      if (update) {
        appStore.pendingUpdate = update
      }
      preferenceStore.updateAndSave({ lastCheckUpdateTime: Date.now() })
    } catch (e) {
      logger.warn('Updater', 'auto check failed: ' + (e as Error).message)
    }
  }

  async function autoSyncTrackerOnStartup() {
    const config = preferenceStore.config
    if (!config.autoSyncTracker) return

    const lastSync = config.lastSyncTrackerTime || 0
    if (Date.now() - lastSync < AUTO_SYNC_TRACKER_INTERVAL) return

    const sources = config.trackerSource?.length ? config.trackerSource : DEFAULT_TRACKER_SOURCE
    try {
      const result = await preferenceStore.fetchBtTracker(sources)
      const text = convertTrackerDataToLine(result.data)
      if (!text) return

      const comma = convertTrackerDataToComma(result.data)
      await preferenceStore.updateAndSave({
        btTracker: comma,
        trackerSource: sources,
        lastSyncTrackerTime: Date.now(),
      })

      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('save_system_config', { config: { 'bt-tracker': reduceTrackerString(comma) } })
      logger.info('Tracker', `Auto-synced: ${result.data.length}/${sources.length} source(s) succeeded`)
    } catch (e) {
      logger.debug('Tracker', 'auto-sync failed: ' + (e as Error).message)
    }
  }

  // ---------------------------------------------------------------------------
  // Startup orchestration
  //
  // The chain is split into phases that run as parallel as possible so the
  // window appears almost instantly while the engine boots in the background.
  //
  //  Phase 1 (critical path)   – loadPreference → locale → window.show()
  //  Phase 2 (engine, async)   – rpcSecret → save config → start engine
  //                              → on_engine_ready (Rust) → wait_for_engine
  //  Phase 3 (non-critical)    – autostart, protocol sync (parallel)
  //  Phase 4 (deferred)        – update check, tracker sync, FS warmup,
  //                              clipboard monitor
  // ---------------------------------------------------------------------------

  /** Start the aria2 engine, wait for readiness, and connect the RPC client.
   *  Returns `true` if the engine is usable, `false` on failure. */
  async function initEngine(port: number, secret: string, config: AppConfig): Promise<boolean> {
    try {
      const { invoke } = await import('@tauri-apps/api/core')

      // Resolve OS-specific Downloads directory as fallback when config.dir
      // is empty. Without this, aria2 receives no --dir arg and defaults to
      // CWD, which is read-only on macOS .app bundles (errorCode=16).
      //
      // Three-tier fallback:
      //   1. downloadDir()            — ~/Downloads (via Tauri path API)
      //   2. homeDir() + '/Downloads' — manual construction
      //   3. homeDir()                — last resort (home dir always exists)
      let defaultDir = ''
      if (!config.dir) {
        const { downloadDir, homeDir } = await import('@tauri-apps/api/path')
        try {
          defaultDir = await downloadDir()
        } catch (e) {
          logger.warn('Engine', `downloadDir() unavailable, falling back to homeDir: ${e}`)
          try {
            defaultDir = (await homeDir()) + '/Downloads'
          } catch (e) {
            logger.warn('Engine', `homeDir() unavailable, dir fallback exhausted: ${e}`)
          }
        }
        // Persist the resolved dir so future launches skip the fallback chain
        if (defaultDir) {
          config.dir = defaultDir
          preferenceStore.updateAndSave({ dir: defaultDir })
          logger.info('Engine', `resolved default download dir: ${defaultDir}`)
        }
      }

      // Seed system.json with the FULL set of default system config values.
      // This ensures CLI args include --split, --max-connection-per-server,
      // --user-agent, etc. even before the user opens the preference page.
      // On subsequent launches, saved values from Downloads/BT/Network/Advanced
      // preferences already exist in system.json and will be merged (not overwritten).
      const { buildDownloadsSystemConfig, buildDownloadsForm } = await import('@/composables/useDownloadsPreference')
      const { buildBtSystemConfig, buildBtForm } = await import('@/composables/useBtPreference')
      const { buildNetworkSystemConfig, buildNetworkForm } = await import('@/composables/useNetworkPreference')
      const { buildAdvancedSystemConfig, buildAdvancedForm } = await import('@/composables/useAdvancedPreference')

      const downloadsSystem = buildDownloadsSystemConfig(buildDownloadsForm(config, defaultDir))
      const btSystem = buildBtSystemConfig(buildBtForm(config))
      const networkSystem = buildNetworkSystemConfig(buildNetworkForm(config))
      const { form: advForm } = buildAdvancedForm(config)
      const advancedSystem = buildAdvancedSystemConfig(advForm)

      await invoke('save_system_config', {
        config: {
          ...downloadsSystem,
          ...btSystem,
          ...networkSystem,
          ...advancedSystem,
          // Override with runtime values — secret may have been auto-generated
          'rpc-secret': secret,
          'rpc-listen-port': String(port),
        },
      })
      // start_engine_command ONLY spawns the aria2c sidecar.
      // Credential update + option sync happen in wait_for_engine
      // (after aria2c is confirmed ready).
      await invoke('start_engine_command')
    } catch (e) {
      logger.error('Engine', e)
      return false
    }

    // Rust-side health check: probe → on_engine_ready (credential + option sync)
    const ready = await waitForEngine()
    if (!ready) {
      logger.error('Engine', 'Engine did not become ready after retries')
      return false
    }

    // Mark frontend as ready — invoke() transport is always available
    const { setEngineReady } = await import('@/api/aria2')
    setEngineReady(true)
    logger.info('Engine', `Rust aria2 client connected via invoke() on port ${port}`)
    return true
  }

  /**
   * Sync autostart state with persisted preference.
   *
   * When `openAtLogin` is true we **always** call `enable()`, even if
   * `isEnabled()` reports true.  This is a deliberate workaround for
   * auto-launch crate v0.5.0 bug: on Windows the registry entry under
   * `HKCU\...\Run` is sometimes removed after the first successful
   * launch (tauri-apps/plugins-workspace#771).  Re-calling `enable()`
   * is idempotent and guarantees the entry + `--autostart` args are
   * present for the next boot.
   */
  async function syncAutostart(config: typeof preferenceStore.config): Promise<void> {
    try {
      const { isEnabled, enable, disable } = await import('@tauri-apps/plugin-autostart')
      const currentlyEnabled = await isEnabled()

      if (config.openAtLogin) {
        // Always re-enable to self-heal the registry (#771 workaround).
        await enable()
        logger.info('main.autostart', `ensured enabled (was=${currentlyEnabled} openAtLogin=${config.openAtLogin})`)
      } else if (currentlyEnabled) {
        await disable()
        logger.info('main.autostart', 'disabled (openAtLogin=false)')
      }
    } catch (e) {
      logger.debug('main.autostart', e)
    }
  }

  /**
   * Cross-platform protocol handler sync.
   *
   * For each enabled protocol, queries the OS via `is_default_protocol_client`
   * (macOS: NSWorkspace, Windows: win_registry, Linux: deep-link plugin).
   *
   * If an enabled protocol is not handled by this app:
   *  1. Sends an OS-level notification (visible even if window is hidden)
   *  2. Signals appStore.pendingProtocolHijack for the UI dialog
   *
   * Does NOT auto-disable config toggles — the user decides in Settings.
   */
  async function syncProtocolHandlers(config: typeof preferenceStore.config): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const hijacked: string[] = []

      for (const [protocol, enabled] of Object.entries(config.protocols)) {
        if (!enabled) continue
        try {
          const isDefault = await invoke<boolean>('is_default_protocol_client', { protocol })
          if (!isDefault) {
            logger.info('ProtocolSync', `${protocol} is not the default handler`)
            hijacked.push(protocol)
          }
        } catch (e) {
          // Per-protocol errors must not block other protocols
          logger.debug('ProtocolSync', `${protocol}: ${(e as Error).message}`)
        }
      }

      if (hijacked.length === 0) return

      // 1. OS-level notification
      const { notifyOs } = await import('@/composables/useOsNotification')
      await notifyOs(
        i18n.global.t('app.protocol-hijacked-title'),
        i18n.global.t('app.protocol-hijacked-body', { protocols: hijacked.join(', ') }),
      )

      // 2. Signal UI to show dialog (consumed by MainLayout/useAppEvents)
      //    Does NOT modify config — user keeps control of their toggles.
      appStore.pendingProtocolHijack = hijacked
    } catch (e) {
      logger.debug('ProtocolSync', e)
    }
  }

  preferenceStore.loadPreference().then(async () => {
    // ── Phase 1: critical path → window visible ASAP ──────────────────────
    const storedLocale = preferenceStore.locale
    let resolvedLocale: string

    if (!storedLocale || storedLocale === 'auto') {
      // First install (empty/auto) or explicit Follow System mode:
      // detect the OS locale and resolve to the closest available match.
      try {
        const raw = (await getLocale()) || 'en-US'
        resolvedLocale = resolveSystemLocale(raw, i18n.global.availableLocales)
      } catch (e) {
        logger.debug('main.locale', e)
        resolvedLocale = 'en-US'
      }

      if (!storedLocale) {
        // Legacy first-install path (locale was ''): persist 'auto' so
        // subsequent launches continue to follow the system language.
        preferenceStore.updatePreference({ locale: 'auto' })
        preferenceStore.savePreference()
      }
      // When storedLocale is already 'auto', we intentionally do NOT
      // overwrite it — the config stays 'auto' across restarts.
    } else {
      // Explicit locale chosen by the user (e.g. 'zh-CN', 'ja').
      resolvedLocale = storedLocale
    }

    // Apply resolved locale to vue-i18n and expose it on the store
    // so downstream consumers (direction, General.vue) can read it.
    if (resolvedLocale) {
      setI18nLocale(i18n, resolvedLocale)
    }

    // Flush deferred migration toasts now that i18n locale is active.
    // loadPreference() buffers these signals to avoid showing English toasts.
    preferenceStore.flushMigrationSignals()

    const config = preferenceStore.config

    // ── Phase 2: engine startup (non-blocking) ────────────────────────────
    const port = config.rpcListenPort || ENGINE_RPC_PORT
    // Distinguish "never set" (undefined/null → auto-generate) from
    // "intentionally cleared" ('' → respect user choice).
    let secret = config.rpcSecret

    if (secret == null) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      const values = crypto.getRandomValues(new Uint8Array(16))
      secret = Array.from(values, (v) => chars[v % chars.length]).join('')
      await preferenceStore.updateAndSave({ rpcSecret: secret })
    }

    // Auto-generate extensionApiSecret on first launch (independent from rpcSecret).
    // Distinction: undefined/null = never set → generate. '' = user intentionally cleared → respect.
    if (config.extensionApiSecret == null) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      const values = crypto.getRandomValues(new Uint8Array(16))
      const apiSecret = Array.from(values, (v) => chars[v % chars.length]).join('')
      await preferenceStore.updateAndSave({ extensionApiSecret: apiSecret })
    }

    taskStore.setApi(aria2Api)

    // Engine initializes in the background — does NOT block the UI.
    // appStore.engineRestarting drives the engine banner in MainLayout.
    const enginePromise = initEngine(port, secret, config)

    // ── Phase 3: non-critical IPC (parallel) ──────────────────────────────
    //
    // External input routing is owned by Rust and consumed from
    // `take_pending_deep_links` after MainLayout registers listeners. Do not
    // call tauri-plugin-deep-link `getCurrent()` here: that value is
    // process-level plugin state, so lightweight-mode WebView recreation would
    // replay stale torrent/protocol inputs.
    Promise.allSettled([syncAutostart(config), syncProtocolHandlers(config)])

    // Start UPnP port mapping if enabled (fire-and-forget)
    if (config.enableUpnp) {
      import('@tauri-apps/api/core')
        .then(({ invoke }) =>
          invoke('start_upnp_mapping', {
            btPort: Number(config.listenPort) || 21301,
            dhtPort: Number(config.dhtListenPort) || 26701,
          }),
        )
        .catch((e) => logger.warn('UPnP', 'startup mapping failed: ' + e))
    }

    // ── Phase 2 completion: engine ready ───────────────────────────────────
    // try/finally guarantees engineRestarting always clears, even on failure.
    // engineReady distinguishes success from failure for the UI toast.
    try {
      const ok = await enginePromise
      appStore.engineReady = ok

      // Global option sync and speed scheduler are now handled by Rust:
      // - on_engine_ready() syncs system.json options to aria2 via changeGlobalOption
      // - spawn_speed_scheduler() runs a 60s timer in tokio (no WebView needed)
      if (ok) {
        logger.info('Engine', 'Rust on_engine_ready completed: options synced, services spawned')
      }
    } catch (e) {
      logger.error('Engine', 'unexpected startup error: ' + e)
      appStore.engineReady = false
    } finally {
      appStore.setEngineRestarting(false)
    }

    // Resume all paused/waiting tasks on launch if configured
    if (config.resumeAllWhenAppLaunched) {
      taskStore.resumeAllTask().catch((e) => logger.debug('main.resumeAll', e))
    }

    // ── Phase 4: deferred non-critical tasks ───────────────────────────────
    autoCheckForUpdate()
    autoSyncTrackerOnStartup()

    // Initialize download history database, then schedule stale record cleanup
    historyStore
      .init({
        onCorrupt: () => logger.warn('HistoryDB', 'Database corrupted, rebuilding…'),
        onError: (e) => logger.warn('HistoryDB', `Load failed, rebuilding… ${e}`),
        onRebuilt: () => logger.info('HistoryDB', 'Database rebuilt successfully'),
        onRebuildFailed: (e) => logger.error('HistoryDB', `Rebuild failed: ${e}`),
      })
      .then(() => {
        // Auto-delete stale records if enabled — delayed to avoid startup contention
        if (preferenceStore.config?.autoDeleteStaleRecords) {
          const runCleanup = async () => {
            try {
              const { runStaleRecordCleanup } = await import('./composables/useStaleCleanup')
              const { extractHistoryFilePaths } = await import('./composables/useTaskLifecycle')
              const records = await historyStore.getRecords('complete')
              const result = await runStaleRecordCleanup(
                records.map((r) => ({
                  gid: r.gid,
                  name: r.name,
                  dir: r.dir ?? '',
                  filePaths: extractHistoryFilePaths(r),
                })),
                historyStore.removeStaleRecords,
              )
              if (result.removed > 0) {
                logger.info('StaleCleanup', `Removed ${result.removed}/${result.scanned} stale records`)
              }
            } catch (e) {
              logger.debug('StaleCleanup', e)
            }
          }
          // First scan 30s after startup — not urgent
          setTimeout(runCleanup, 30_000)
          // Re-scan every 30 minutes for long-running sessions
          setInterval(runCleanup, 1_800_000)
        }
      })
      .catch((e) => logger.warn('HistoryDB', 'init failed: ' + e))

    // Re-check tracker sync hourly for long-running sessions.
    // autoSyncTrackerOnStartup() internally de-duplicates via lastSyncTrackerTime.
    setInterval(autoSyncTrackerOnStartup, 3_600_000)

    // Warm up Tauri FS plugin IPC channel to eliminate cold-start delay on first
    // file operation (e.g. task deletion).
    setTimeout(() => {
      import('@tauri-apps/plugin-fs').then(({ exists }) => exists('/')).catch(() => {})
    }, 3000)

    // ── Lightweight mode: destroy WebView after autostart init ─────────
    //
    // When autostart + autoHideWindow + lightweightMode are all enabled,
    // destroy the WebView to free ~300MB RAM.  This MUST run after all
    // critical invoke() calls complete (engine start, option sync,
    // resume-all, history init) because invoke() requires a live WebView.
    //
    // Delegates to handle_minimize_to_tray() in Rust which handles:
    //   - end_cold_start()  → prevents re-hide on window recreation
    //   - lightweightMode   → window.destroy() vs window.hide()
    //   - macOS Dock hiding → hideDockOnMinimize (cfg-gated in Rust)
    //
    // Cross-platform: macOS (WKWebView), Windows (WebView2), Linux (WebKitGTK)
    // all release the renderer process on destroy().  ExitRequested handler
    // in handle_run_event() calls prevent_exit() to keep the process alive.
    if (config.lightweightMode && config.autoHideWindow) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const isAutostart = await invoke<boolean>('is_autostart_launch')
        if (isAutostart) {
          logger.info('main', 'autostart + lightweight: destroying WebView via minimize_to_tray')
          await invoke('minimize_to_tray')
          // WebView destroyed — JS execution stops here.
          // All background services (stat, monitor, speed scheduler) continue in Rust.
          return
        }
      } catch (e) {
        // Non-fatal: WebView stays alive (standard autostart-hide behavior).
        // Graceful degradation — the user just doesn't get the RAM savings.
        logger.debug('main.lightweightAutostart', e)
      }
    }

    let lastClipboardText = ''
    getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
      if (!focused) return
      if (appStore.addTaskVisible) return
      const clipboardConfig = preferenceStore.config.clipboard
      if (!clipboardConfig?.enable) return
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
        const text = ((await readText()) || '').trim()
        if (!text || text === lastClipboardText) return
        const { detectResource } = await import('@shared/utils')
        if (detectResource(text, clipboardConfig)) {
          lastClipboardText = text
          appStore.showAddTaskDialog()
        }
      } catch (e) {
        logger.debug('Main.clipboardMonitor', e)
      }
    })
  })
} // end: main window initialization
