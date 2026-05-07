/**
 * @fileoverview Structural tests for autostart-only silent startup.
 *
 * Industry standard (Discord, Telegram, Steam, Clash Verge):
 *   - System autostart → minimize to tray (silent)
 *   - Manual user launch → show main window
 *
 * The Tauri autostart plugin passes `--autostart` as a CLI arg when the
 * OS triggers an auto-launch.  The setup() function in lib.rs checks
 * for this arg and force-hides the window before the frontend mounts.
 *
 * Architecture: Two-layer defense-in-depth (Rust primary + frontend secondary).
 * See lib.rs autostart-silent-mode-guard and MainLayout.vue onMounted.
 *
 * Verifies:
 * 1. autostart plugin is initialized with `--autostart` arg (not None)
 * 2. Rust setup() has an active autostart force-hide guard
 * 3. macOS Dock-hide block also checks `--autostart`
 * 4. StateFlags::VISIBLE is excluded from window-state
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')
const TAURI_ROOT = path.join(PROJECT_ROOT, 'src-tauri')

describe('lib.rs — autostart-only silent startup', () => {
  let libSource: string

  beforeAll(() => {
    libSource = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
  })

  // ─── Test 1: autostart plugin passes --autostart arg ─────────────

  describe('autostart plugin initialization', () => {
    it('passes "--autostart" arg to tauri_plugin_autostart::init', () => {
      // The init call must use Some(vec!["--autostart"]) not None
      // This ensures the OS auto-launch entry includes the flag
      expect(libSource).toContain('tauri_plugin_autostart::init')
      // Must NOT use None as the args parameter
      const initBlock = extractAutoStartInitBlock(libSource)
      expect(initBlock).toBeTruthy()
      expect(initBlock).toContain('"--autostart"')
      expect(initBlock).not.toMatch(/\bNone\b/)
    })

    it('uses Some(vec![...]) to wrap the autostart arg', () => {
      const initBlock = extractAutoStartInitBlock(libSource)
      expect(initBlock).toBeTruthy()
      // Must wrap args in Some(vec![...]) per Tauri plugin API
      expect(initBlock).toContain('Some(vec!')
    })
  })

  // ─── Test 2: Rust-layer active autostart force-hide ────────────────

  describe('autostart force-hide window guard (Rust layer)', () => {
    it('has an active autostart silent-mode guard in setup()', () => {
      // The Rust setup() must actively hide the window on autostart.
      // This is the primary defense — it runs before the frontend mounts.
      expect(libSource).toContain('autostart silent-mode guard')
    })

    it('calls w.hide() in the guard block', () => {
      const guardBlock = extractSilentModeGuardBlock(libSource)
      expect(guardBlock).toBeTruthy()
      expect(guardBlock).toContain('w.hide()')
    })

    it('exposes is_autostart_launch command for frontend to check', () => {
      expect(libSource).toContain('is_autostart_launch')
    })

    it('frontend checks autoHideWindow AND is_autostart_launch before showing', () => {
      const mainLayout = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'layouts', 'MainLayout.vue'), 'utf-8')
      expect(mainLayout).toContain('is_autostart_launch')
      expect(mainLayout).toContain('autoHideWindow')
    })
  })

  // ─── Test 3: macOS Dock-hide also checks --autostart ─────────────

  describe('macOS Dock-hide logic', () => {
    it('reads --autostart in the macOS Dock-hide block', () => {
      // The Dock-hide block (ActivationPolicy::Accessory) must also
      // respect --autostart — hiding the Dock icon on manual launch
      // would confuse users.
      const dockBlock = extractDockHideBlock(libSource)
      expect(dockBlock).toBeTruthy()
      expect(dockBlock).toContain('"--autostart"')
    })

    it('combines dock_hide AND is_autostart for Dock hiding', () => {
      const dockBlock = extractDockHideBlock(libSource)
      expect(dockBlock).toBeTruthy()
      expect(dockBlock).toContain('is_autostart')
      expect(dockBlock).toMatch(/hide_dock\s*&&\s*is_autostart/)
    })
  })

  // ─── Test 4: window visibility controlled by Rust + frontend ─────

  describe('window visibility architecture', () => {
    it('excludes StateFlags::VISIBLE from window-state plugin', () => {
      // VISIBLE must be excluded so the plugin does not restore
      // window visibility and race with the autostart guard.
      expect(libSource).toContain('!StateFlags::VISIBLE')
    })

    it('Rust setup has the autostart guard in setup_app function', () => {
      const setupBlock = extractSetupBlock(libSource)
      expect(setupBlock).toBeTruthy()
      expect(setupBlock).toContain('autostart silent-mode guard')
    })

    it('exposes is_autostart_launch in the invoke_handler', () => {
      expect(libSource).toContain('is_autostart_launch')
    })
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the tauri_plugin_autostart::init(...) call block.
 * Returns the full init() invocation including both arguments.
 */
function extractAutoStartInitBlock(source: string): string | null {
  const idx = source.indexOf('tauri_plugin_autostart::init(')
  if (idx === -1) return null
  const openParen = source.indexOf('(', idx)
  let depth = 0
  let end = openParen
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++
    if (source[i] === ')') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(idx, end + 1)
}

/**
 * Extract the macOS Dock-hide block.
 * Identified by the comment "Hide Dock icon on startup".
 */
function extractDockHideBlock(source: string): string | null {
  const marker = 'Hide Dock icon on startup'
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
 * Extract the autostart silent-mode guard block.
 * Identified by the comment "Autostart silent-mode guard".
 */
function extractSilentModeGuardBlock(source: string): string | null {
  const marker = 'Autostart silent-mode guard'
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
