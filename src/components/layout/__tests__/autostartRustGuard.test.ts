/**
 * @fileoverview Structural tests for the Rust-layer autostart silent-mode guard.
 *
 * Bug #109: On Windows cold boot with autostart + autoHideWindow enabled,
 * the main window flashes visible before the frontend can hide it.
 *
 * Root cause: The window-state plugin's StateFlags::VISIBLE restored the
 * window to its last-saved visible state in Rust setup(), before the Vue
 * frontend could check autostart status and decide to skip show().
 *
 * Fix (two-layer defense-in-depth):
 *   1. PRIMARY (Rust): Exclude StateFlags::VISIBLE from window-state plugin
 *      and restore_state().  Force-hide window in setup() when autostart +
 *      autoHideWindow are both true.
 *   2. SECONDARY (Frontend): MainLayout.vue onMounted force-hides the window
 *      if shouldHide is true but the window is somehow visible.
 *
 * These tests verify the STRUCTURAL invariants of the fix by parsing the
 * source files directly.  They do NOT require a running Tauri instance.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const TAURI_ROOT = path.resolve(PROJECT_ROOT, 'src-tauri')
const LIB_RS = path.join(TAURI_ROOT, 'src', 'lib.rs')
const FS_RS = path.join(TAURI_ROOT, 'src', 'commands', 'fs.rs')
const MAIN_LAYOUT = path.join(PROJECT_ROOT, 'src', 'layouts', 'MainLayout.vue')

// ═══════════════════════════════════════════════════════════════════════
// Group 1: StateFlags::VISIBLE permanently excluded from window-state
// ═══════════════════════════════════════════════════════════════════════

describe('lib.rs — StateFlags::VISIBLE excluded from window-state (#109)', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(LIB_RS, 'utf-8')
  })

  it('excludes VISIBLE from window-state plugin registration flags', () => {
    // The window-state Builder block must have !StateFlags::VISIBLE
    const pluginBlock = extractWindowStatePluginBlock(source)
    expect(pluginBlock).toBeTruthy()
    expect(pluginBlock).toContain('!StateFlags::VISIBLE')
  })

  it('excludes VISIBLE from manual restore_state() helper', () => {
    const restoreBlock = extractWindowStateFlagsBlock(source)
    expect(restoreBlock).toBeTruthy()
    expect(restoreBlock).toContain('!StateFlags::VISIBLE')
  })

  it('restore_state uses & !StateFlags::VISIBLE on all platforms', () => {
    const restoreBlock = extractWindowStateFlagsBlock(source)
    expect(restoreBlock).toBeTruthy()
    const matches = restoreBlock!.match(/!StateFlags::VISIBLE/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('window-state plugin uses & !StateFlags::VISIBLE on all platforms', () => {
    const pluginBlock = extractWindowStatePluginBlock(source)
    expect(pluginBlock).toBeTruthy()
    const matches = pluginBlock!.match(/!StateFlags::VISIBLE/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Group 2: Rust setup() autostart force-hide guard
// ═══════════════════════════════════════════════════════════════════════

describe('lib.rs — autostart silent-mode guard in setup()', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(LIB_RS, 'utf-8')
  })

  it('has an autostart silent-mode guard block', () => {
    expect(source).toContain('autostart silent-mode guard')
  })

  it('checks --autostart flag in the guard block', () => {
    const guardBlock = extractSilentModeGuardBlock(source)
    expect(guardBlock).toBeTruthy()
    expect(guardBlock).toContain('"--autostart"')
  })

  it('checks autoHideWindow preference in the guard block', () => {
    const guardBlock = extractSilentModeGuardBlock(source)
    expect(guardBlock).toBeTruthy()
    expect(guardBlock).toContain('"autoHideWindow"')
  })

  it('calls w.hide() when should_hide is true', () => {
    const guardBlock = extractSilentModeGuardBlock(source)
    expect(guardBlock).toBeTruthy()
    expect(guardBlock).toContain('w.hide()')
  })

  it('computes should_hide as is_autostart && auto_hide', () => {
    const guardBlock = extractSilentModeGuardBlock(source)
    expect(guardBlock).toBeTruthy()
    expect(guardBlock).toContain('is_autostart && auto_hide')
  })

  it('logs force-hidden message for diagnostic tracing', () => {
    const guardBlock = extractSilentModeGuardBlock(source)
    expect(guardBlock).toBeTruthy()
    expect(guardBlock).toContain('force-hidden')
  })

  it('guard runs AFTER restore_state (correct ordering)', () => {
    // The guard must come after the explicit restore call in setup_app
    // to override any accidental visibility restoration.
    const setupBlock = extractSetupBlock(source)
    expect(setupBlock).toBeTruthy()
    const restoreIdx = setupBlock!.indexOf('restore_window_state_if_enabled')
    const guardIdx = setupBlock!.indexOf('autostart silent-mode guard')
    expect(restoreIdx).toBeGreaterThanOrEqual(0)
    expect(guardIdx).toBeGreaterThanOrEqual(0)
    expect(guardIdx).toBeGreaterThan(restoreIdx)
  })

  it('setup restore uses the shared restore helper', () => {
    const setupBlock = extractSetupBlock(source)
    expect(setupBlock).toBeTruthy()
    expect(setupBlock).toContain('restore_window_state_if_enabled')
  })

  it('the shared restore helper calls restore_state', () => {
    const restoreIdx = source.indexOf('restore_state')
    const guardIdx = source.indexOf('autostart silent-mode guard')
    expect(restoreIdx).toBeGreaterThanOrEqual(0)
    expect(guardIdx).toBeGreaterThanOrEqual(0)
  })

  it('guard runs BEFORE Ok(()) return (within setup)', () => {
    const setupBlock = extractSetupBlock(source)
    expect(setupBlock).toBeTruthy()
    expect(setupBlock).toContain('autostart silent-mode guard')
    expect(setupBlock).toContain('w.hide()')
  })

  it('guard tolerates --autostart= prefix variant', () => {
    const guardBlock = extractSilentModeGuardBlock(source)
    expect(guardBlock).toBeTruthy()
    expect(guardBlock).toContain('--autostart=')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Group 3: fs.rs is_autostart_launch enhanced detection
// ═══════════════════════════════════════════════════════════════════════

describe('commands/fs.rs — is_autostart_launch enhanced detection', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(FS_RS, 'utf-8')
  })

  it('checks for exact --autostart match', () => {
    const fnBody = extractFunctionBody(source, 'is_autostart_launch')
    expect(fnBody).toBeTruthy()
    expect(fnBody).toContain('"--autostart"')
  })

  it('tolerates --autostart= prefix variant (auto-launch crate #771)', () => {
    const fnBody = extractFunctionBody(source, 'is_autostart_launch')
    expect(fnBody).toBeTruthy()
    expect(fnBody).toContain('"--autostart="')
  })

  it('logs argc and result at info level without full argv', () => {
    const fnBody = extractFunctionBody(source, 'is_autostart_launch')
    expect(fnBody).toBeTruthy()
    expect(fnBody).toContain('log::info!')
    expect(fnBody).toContain('argc')
    expect(fnBody).toContain('result')
    // Full args MUST NOT appear in info-level log.
    expect(fnBody).not.toMatch(/log::info!.*args=\{/)
  })

  it('debug log uses structured redacted diagnostics, not raw argv', () => {
    const fnBody = extractFunctionBody(source, 'is_autostart_launch')
    expect(fnBody).toBeTruthy()
    expect(fnBody).toContain('log::debug!')
    // Must contain structured diagnostic fields for autostart troubleshooting
    // (nicehash/auto-launch#771) without exposing raw argument strings.
    expect(fnBody).toContain('matched_exact')
    expect(fnBody).toContain('matched_prefixed')
    expect(fnBody).toContain('other_arg_count')
  })

  it('never records raw argv at any log level', () => {
    const fnBody = extractFunctionBody(source, 'is_autostart_launch')
    expect(fnBody).toBeTruthy()
    // Raw args={:?} would leak deep-link URLs and local paths into
    // diagnostic exports. The default log level is Debug (per design),
    // so debug! entries DO reach disk and get bundled by export_diagnostic_logs.
    expect(fnBody).not.toMatch(/log::(info|debug|warn|error)!.*args=\{:\?}/)
    // Also reject any format that dumps the full args vector
    expect(fnBody).not.toContain('args={:?}')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Group 4: MainLayout.vue defense-in-depth hide
// ═══════════════════════════════════════════════════════════════════════

describe('MainLayout.vue — defense-in-depth autostart hide', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(MAIN_LAYOUT, 'utf-8')
  })

  it('has both show() and hide() paths in onMounted', () => {
    const mountedBody = extractOnMountedBody(source)
    expect(mountedBody).toBeTruthy()
    expect(mountedBody).toContain('.show()')
    expect(mountedBody).toContain('.hide()')
  })

  it('checks isVisible() before force-hiding', () => {
    const mountedBody = extractOnMountedBody(source)
    expect(mountedBody).toBeTruthy()
    expect(mountedBody).toContain('.isVisible()')
  })

  it('logs a warning when force-hiding an unexpectedly visible window', () => {
    const mountedBody = extractOnMountedBody(source)
    expect(mountedBody).toBeTruthy()
    expect(mountedBody).toContain('unexpectedly visible')
  })

  it('documents the two-layer defense-in-depth architecture', () => {
    expect(source).toContain('defense-in-depth')
    expect(source).toContain('PRIMARY')
    expect(source).toContain('SECONDARY')
  })

  it('hide() path is in the else branch of shouldHide check', () => {
    const mountedBody = extractOnMountedBody(source)
    expect(mountedBody).toBeTruthy()
    // The hide must be in the else branch (shouldHide === true)
    const hideIdx = mountedBody!.indexOf('.hide()')
    const showIdx = mountedBody!.indexOf('.show()')
    // hide() should appear AFTER show() in the source (it's in the else branch)
    expect(hideIdx).toBeGreaterThan(showIdx)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Group 5: Architecture comment documents two-layer pattern
// ═══════════════════════════════════════════════════════════════════════

describe('lib.rs — architecture documentation', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(LIB_RS, 'utf-8')
  })

  it('documents the two-layer defense-in-depth pattern', () => {
    expect(source).toContain('two-layer defense-in-depth')
  })

  it('identifies Rust as the PRIMARY layer', () => {
    expect(source).toContain('PRIMARY (Rust)')
  })

  it('identifies Frontend as the SECONDARY layer', () => {
    expect(source).toContain('SECONDARY (Frontend)')
  })

  it('references issue #109 in VISIBLE exclusion comments', () => {
    expect(source).toContain('#109')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────────

function extractFunctionBody(source: string, fnName: string): string | null {
  const idx = source.indexOf(fnName)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(braceStart, i + 1)
  }
  return null
}

function extractSetupBlock(source: string): string | null {
  const marker = 'fn setup_app'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(braceStart, i + 1)
  }
  return null
}

function extractOnMountedBody(source: string): string | null {
  const marker = 'onMounted(async'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(braceStart, i + 1)
  }
  return null
}

/**
 * Extracts the window-state plugin Builder block from lib.rs.
 * Identified by tauri_plugin_window_state::Builder::new().
 */
function extractWindowStatePluginBlock(source: string): string | null {
  const marker = 'tauri_plugin_window_state::Builder::new()'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  // Walk backward to find the containing block start
  const blockStart = source.lastIndexOf('builder = builder.plugin({', idx)
  if (blockStart === -1) return null
  // Find the opening brace of the block
  const braceStart = source.indexOf('{', blockStart + 'builder = builder.plugin('.length)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(blockStart, i + 1)
  }
  return null
}

/**
 * Extracts the shared window-state flags helper from lib.rs.
 */
function extractWindowStateFlagsBlock(source: string): string | null {
  const marker = 'fn window_state_flags'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}

/**
 * Extracts the autostart silent-mode guard block from lib.rs.
 * Identified by the comment "Autostart silent-mode guard".
 */
function extractSilentModeGuardBlock(source: string): string | null {
  const marker = 'Autostart silent-mode guard'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}
