/**
 * @fileoverview Structural tests for tray quit behavior in lightweight mode.
 *
 * Industry standard (Discord, Telegram, Slack, Steam):
 *   - Tray right-click → Quit → directly exits (no confirmation dialog)
 *   - Window X button → may show minimize/quit dialog
 *
 * Architecture change (issue #194):
 *   Previously: tray-quit → emit("tray-menu-action", "quit") → frontend handleExitConfirm()
 *   Now:        tray-quit → app.exit(0) directly in Rust on_menu_event
 *
 * This change is critical because in lightweight mode, window.destroy() kills
 * the WebView — making the frontend unreachable for app.emit() events.
 * The quit action must be handled entirely in Rust.
 *
 * Verifies:
 * 1. Rust: tray-quit calls app.exit(0) directly (NOT emit to frontend)
 * 2. Rust: tray-new-task recreates window before emitting (NOT raw emit)
 * 3. Vue: tray quit case in frontend is kept for backward compat but redundant
 * 4. Vue: onCloseRequested still allows showExitDialog for window close
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const MAIN_LAYOUT = path.join(PROJECT_ROOT, 'src', 'layouts', 'MainLayout.vue')
const TRAY_RS = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'tray.rs')
const APP_EVENTS_TS = path.join(PROJECT_ROOT, 'src', 'composables', 'useAppEvents.ts')

// ═══════════════════════════════════════════════════════════════════
// Group 1: Rust — tray-quit handled natively (not emit)
// ═══════════════════════════════════════════════════════════════════

describe('tray.rs — quit handled natively via app.exit()', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_RS, 'utf-8')
  })

  it('handles tray-quit in on_menu_event with app.exit()', () => {
    const menuEventBlock = extractOnMenuEvent(source)
    expect(menuEventBlock).toBeTruthy()
    // Must contain the tray-quit match arm
    expect(menuEventBlock).toContain('"tray-quit"')
    // Must call app.exit() directly in on_menu_event
    expect(menuEventBlock).toContain('app.exit(')
  })

  it('does NOT route tray-quit through resolve_tray_action', () => {
    // resolve_tray_action should return None for tray-quit because
    // it is handled directly in on_menu_event, not emitted to frontend
    const resolverBody = extractResolverBody(source)
    expect(resolverBody).toBeTruthy()
    // The resolver should NOT map tray-quit to any action
    const quitMatch = resolverBody!.match(/"tray-quit"\s*=>\s*Some/)
    expect(quitMatch).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 2: Rust — tray-new-task recreates window before emit
// ═══════════════════════════════════════════════════════════════════

describe('tray.rs — new-task recreates window in lightweight mode', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_RS, 'utf-8')
  })

  it('handles tray-new-task directly in on_menu_event (not via resolve_tray_action)', () => {
    const menuEventBlock = extractOnMenuEvent(source)
    expect(menuEventBlock).toBeTruthy()
    expect(menuEventBlock).toContain('"tray-new-task"')
  })

  it('calls get_or_create_main_window before emitting new-task', () => {
    const menuEventBlock = extractOnMenuEvent(source)
    expect(menuEventBlock).toBeTruthy()
    // Must recreate window before emit to ensure frontend exists
    expect(menuEventBlock).toContain('get_or_create_main_window')
    expect(menuEventBlock).toContain('tray-menu-action')
    expect(menuEventBlock).toContain('"new-task"')
  })

  it('does NOT route tray-new-task through resolve_tray_action', () => {
    const resolverBody = extractResolverBody(source)
    expect(resolverBody).toBeTruthy()
    const newTaskMatch = resolverBody!.match(/"tray-new-task"\s*=>\s*Some/)
    expect(newTaskMatch).toBeNull()
  })

  it('marks deep-link frontend readiness stale before recreating the main window', () => {
    const createWindowBody = extractGetOrCreateMainWindow(source)
    expect(createWindowBody).toBeTruthy()
    expect(createWindowBody).toContain('mark_frontend_unready')
    expect(createWindowBody!.indexOf('mark_frontend_unready')).toBeLessThan(
      createWindowBody!.indexOf('builder.build()'),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 3: Vue — frontend exit dialog still works for window close
// ═══════════════════════════════════════════════════════════════════

describe('MainLayout.vue — window close still shows exit dialog', () => {
  it('onCloseRequested still allows showExitDialog for window close', () => {
    const layoutSource = fs.readFileSync(MAIN_LAYOUT, 'utf-8')
    const closeHandler = extractCloseRequestedHandler(layoutSource)
    expect(closeHandler).toBeTruthy()
    expect(closeHandler).toContain('showExitDialog')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 4: Rust — single-instance external input routing (issue #196/#268)
// ═══════════════════════════════════════════════════════════════════

describe('lib.rs — single-instance queues external input before waking the window', () => {
  let source: string

  beforeAll(() => {
    const libPath = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'lib.rs')
    source = fs.readFileSync(libPath, 'utf-8')
  })

  it('routes argv through the shared deep-link service', () => {
    const singleInstanceBlock = extractSingleInstanceCallback(source)
    expect(singleInstanceBlock).toBeTruthy()
    expect(singleInstanceBlock).toContain('filter_external_input_args')
    expect(singleInstanceBlock).toContain('route_external_inputs')
  })

  it('does not rebuild or emit directly in the single-instance callback', () => {
    const singleInstanceBlock = extractSingleInstanceCallback(source)
    expect(singleInstanceBlock).toBeTruthy()
    // Strip Rust // comments so we only check executable code
    const codeOnly = singleInstanceBlock!
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    // Window recreation is scheduled by the shared service when needed.
    expect(codeOnly).not.toMatch(/get_webview_window\(\s*"main"\s*\)/)
    expect(codeOnly).not.toContain('get_or_create_main_window')
    expect(codeOnly).not.toContain('emit("single-instance-triggered"')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 5: Rust — macOS deep-link queues before window wake
// ═══════════════════════════════════════════════════════════════════

describe('lib.rs — macOS deep-link queues external input before waking the window', () => {
  let source: string

  beforeAll(() => {
    const libPath = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'lib.rs')
    source = fs.readFileSync(libPath, 'utf-8')
  })

  it('routes URLs through the shared deep-link service', () => {
    const deepLinkBlock = extractDeepLinkHandler(source)
    expect(deepLinkBlock).toBeTruthy()
    expect(deepLinkBlock).toContain('route_external_inputs')
  })

  it('does not rebuild or emit directly inside on_open_url', () => {
    const deepLinkBlock = extractDeepLinkHandler(source)
    expect(deepLinkBlock).toBeTruthy()
    const codeOnly = deepLinkBlock!
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(codeOnly).not.toContain('get_or_create_main_window')
    expect(codeOnly).not.toContain('emit("deep-link-open"')
  })
})

describe('useAppEvents.ts — legacy single-instance events use shared deep-link processing', () => {
  it('surfaces the window before processing single-instance URLs', () => {
    const source = fs.readFileSync(APP_EVENTS_TS, 'utf-8')
    const listenerBlock = extractSingleInstanceListener(source)
    expect(listenerBlock).toBeTruthy()
    expect(listenerBlock).toContain('processIncomingDeepLinks(urls)')
    expect(listenerBlock).not.toContain('appStore.handleDeepLinkUrls(urls)')
  })

  it('accepts magnet links that do not contain ://', () => {
    const source = fs.readFileSync(APP_EVENTS_TS, 'utf-8')
    const listenerBlock = extractSingleInstanceListener(source)
    expect(listenerBlock).toBeTruthy()
    expect(listenerBlock).toContain("lower.startsWith('magnet:')")
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 6: Rust stat_service — direct tray/dock operations
// ═══════════════════════════════════════════════════════════════════

describe('stat.rs — direct tray/dock/progress operations (no emit)', () => {
  let source: string

  beforeAll(() => {
    const statPath = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'services', 'stat.rs')
    source = fs.readFileSync(statPath, 'utf-8')
  })

  it('uses tray_by_id for tray title (not emit)', () => {
    // stat_service must directly set the tray title via the Tauri tray API,
    // not emit to frontend. This ensures tray speed display keeps updating
    // when the WebView is destroyed in lightweight mode.
    expect(source).toContain('tray_by_id')
    expect(source).toContain('set_title')
  })

  it('uses NSDockTile API for dock badge (not window.set_badge_label)', () => {
    // set_dock_badge() uses NSApp().dockTile().setBadgeLabel() which is
    // app-level — does NOT require a Window object. This fixes the dock badge
    // freeze in lightweight mode where get_webview_window returns None.
    expect(source).toContain('set_dock_badge')
    expect(source).toContain('NSDockTile')
    expect(source).toContain('setBadgeLabel')
  })

  it('dispatches dock badge to main thread', () => {
    // NSDockTile must be accessed on the macOS main thread.
    // stat_service runs on a tokio worker, so it dispatches via
    // app.run_on_main_thread().
    expect(source).toContain('run_on_main_thread')
  })

  it('does NOT emit stat:tray-title to frontend', () => {
    expect(source).not.toContain('"stat:tray-title"')
  })

  it('does NOT emit stat:dock-badge to frontend', () => {
    expect(source).not.toContain('"stat:dock-badge"')
  })

  it('does NOT emit stat:progress to frontend', () => {
    expect(source).not.toContain('"stat:progress"')
  })

  it('polling constants match frontend timing.ts', () => {
    // STAT_BASE_INTERVAL_MS must be 500 (not 3000) to match timing.ts
    expect(source).toMatch(/STAT_BASE_INTERVAL_MS:\s*u64\s*=\s*500/)
    expect(source).toMatch(/STAT_PER_TASK_INTERVAL_MS:\s*u64\s*=\s*100/)
    expect(source).toMatch(/STAT_IDLE_INCREMENT_MS:\s*u64\s*=\s*100/)
  })

  it('normalizes download_speed to 0 when num_active is 0', () => {
    // aria2 uses a 10-second sliding window (SpeedCalc::WINDOW_TIME = 10s).
    // After pausing, stale bytes leak into the speed for up to 10 seconds.
    // Both Rust and frontend must force download_speed = 0 when idle.
    expect(source).toContain('download_speed_raw')
    expect(source).toMatch(/let download_speed\s*=\s*if num_active > 0/)
  })

  it('uses set_dock_progress for macOS progress bar (no Window required)', () => {
    // Progress bar must use set_dock_progress() (NSDockTile + NSProgressIndicator)
    // instead of window.set_progress_bar() — same pattern as dock badge.
    // This ensures the progress bar keeps updating in lightweight mode.
    expect(source).toContain('set_dock_progress')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 7: Rust monitor — DB persistence for lightweight mode
// ═══════════════════════════════════════════════════════════════════

describe('monitor.rs — Rust-side history DB persistence', () => {
  let source: string

  beforeAll(() => {
    const monitorPath = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'services', 'monitor.rs')
    source = fs.readFileSync(monitorPath, 'utf-8')
  })

  it('imports HistoryDb types for DB persistence', () => {
    expect(source).toMatch(/use\s+crate::history/)
  })

  it('calls build_history_record in the monitor loop', () => {
    expect(source).toContain('build_history_record')
  })

  it('writes to history DB via add_record', () => {
    expect(source).toContain('add_record')
  })

  it('uses build_history_meta_json for structured JSON meta (not raw infoHash)', () => {
    // The old code stored `event.info_hash.clone()` as meta — a raw hex string
    // that fails JSON.parse() in the frontend. The new code produces a JSON object
    // matching the frontend's buildHistoryMeta() format.
    expect(source).toContain('build_history_meta_json')
    expect(source).not.toMatch(/let meta\s*=\s*event\.info_hash\.clone/)
  })

  it('TaskEvent carries file snapshots via TaskEventFile', () => {
    // Multi-file BT tasks need file path snapshots for correct deletion
    // and folder-opening after history round-trip.
    expect(source).toContain('pub struct TaskEventFile')
    expect(source).toContain('pub files: Vec<TaskEventFile>')
  })

  it('TaskEvent carries announce_list for magnet reconstruction', () => {
    expect(source).toContain('pub announce_list: Vec<Vec<String>>')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 8: Frontend app store — event-driven stat (no polling)
// ═══════════════════════════════════════════════════════════════════

describe('app.ts — event-driven stat architecture', () => {
  let source: string

  beforeAll(() => {
    const appStorePath = path.join(PROJECT_ROOT, 'src', 'stores', 'app.ts')
    source = fs.readFileSync(appStorePath, 'utf-8')
  })

  it('listens for stat:update events from Rust', () => {
    // The frontend must subscribe to the Rust stat_service's event stream
    // instead of polling aria2 directly. This eliminates double RPC calls.
    expect(source).toContain("listen<StatPayload>('stat:update'")
  })

  it('exports handleStatEvent for processing Rust events', () => {
    expect(source).toContain('handleStatEvent')
  })

  it('exports setupStatListener for lifecycle management', () => {
    expect(source).toContain('setupStatListener')
  })

  it('does NOT invoke update_tray_title (Rust handles tray directly)', () => {
    // After the architectural migration, tray/dock/progress updates
    // are handled exclusively by Rust stat_service.
    expect(source).not.toContain("invoke('update_tray_title'")
  })

  it('does NOT invoke update_dock_badge (Rust handles dock directly)', () => {
    expect(source).not.toContain("invoke('update_dock_badge'")
  })

  it('does NOT invoke update_progress_bar (Rust handles progress directly)', () => {
    expect(source).not.toContain("invoke('update_progress_bar'")
  })

  it('does NOT import usePlatform (no platform-gated UI logic)', () => {
    // usePlatform was only needed for supportsTrayTitle which guarded
    // the now-deleted invoke('update_tray_title') block.
    expect(source).not.toContain('usePlatform')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the .on_menu_event(...) handler block from Rust source.
 */
function extractOnMenuEvent(source: string): string | null {
  const marker = '.on_menu_event('
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}

/**
 * Extract the resolve_tray_action function body.
 */
function extractResolverBody(source: string): string | null {
  const marker = 'fn resolve_tray_action'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}

function extractGetOrCreateMainWindow(source: string): string | null {
  const marker = 'pub fn get_or_create_main_window'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}

/**
 * Extract the onCloseRequested handler body.
 */
function extractCloseRequestedHandler(source: string): string | null {
  const marker = 'onCloseRequested(async'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(idx, end + 1)
}

/**
 * Extract the single-instance callback block from lib.rs.
 */
function extractSingleInstanceCallback(source: string): string | null {
  const marker = 'tauri_plugin_single_instance::init'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}

/**
 * Extract the deep_link().on_open_url() handler block.
 */
function extractDeepLinkHandler(source: string): string | null {
  const marker = 'on_open_url'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}

function extractSingleInstanceListener(source: string): string | null {
  const marker = "listen<string[]>('single-instance-triggered'"
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}
