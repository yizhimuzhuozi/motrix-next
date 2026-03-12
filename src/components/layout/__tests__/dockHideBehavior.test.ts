/**
 * @fileoverview Structural tests for the "Hide Dock Icon on Minimize" feature.
 *
 * The feature involves three separate code paths that hide the main window,
 * each of which must call `set_dock_visible` before hiding. The Rust command
 * reads the `hideDockOnMinimize` preference from the persistent store (not
 * from JS in-memory state) and only sets `ActivationPolicy::Accessory` when
 * the user has opted in.
 *
 * Tests follow the project's structural source-code analysis pattern
 * (see trayFocusBehavior.test.ts) — reading source files and asserting
 * that critical code patterns are present.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC_ROOT = path.resolve(__dirname, '../../../..')
const TAURI_ROOT = path.resolve(SRC_ROOT, 'src-tauri')

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extracts a function body from source code (brace-balanced extraction).
 * Returns the content between the opening `{` and its matching `}`.
 */
function extractFunctionBody(source: string, fnSignature: string): string | null {
  const start = source.indexOf(fnSignature)
  if (start === -1) return null
  const braceStart = source.indexOf('{', start)
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
 * Asserts that `needle` appears before `after` in the given source string.
 * Used to verify call ordering (e.g. set_dock_visible before hide).
 */
function assertOrderedBefore(source: string, needle: string, after: string, context: string): void {
  const needleIdx = source.indexOf(needle)
  const afterIdx = source.indexOf(after, needleIdx)
  expect(needleIdx, `${context}: "${needle}" must exist`).toBeGreaterThanOrEqual(0)
  expect(afterIdx, `${context}: "${after}" must exist`).toBeGreaterThanOrEqual(0)
  expect(needleIdx, `${context}: "${needle}" must appear before "${after}"`).toBeLessThan(afterIdx)
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: WindowControls.vue — custom ✕ button Dock hide
// ═══════════════════════════════════════════════════════════════════

describe('WindowControls.vue — Dock hide on custom close button', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(SRC_ROOT, 'src', 'components', 'layout', 'WindowControls.vue'), 'utf-8')
  })

  it('close() is an async function (required for await invoke)', () => {
    expect(source).toContain('async function close()')
  })

  it('invokes set_dock_visible when minimizeToTrayOnClose is true', () => {
    const closeBody = extractFunctionBody(source, 'async function close()')
    expect(closeBody).toBeTruthy()
    expect(closeBody).toContain("invoke('set_dock_visible'")
  })

  it('calls set_dock_visible BEFORE appWindow.hide()', () => {
    const closeBody = extractFunctionBody(source, 'async function close()')!
    assertOrderedBefore(closeBody, "invoke('set_dock_visible'", 'appWindow.hide()', 'WindowControls.close()')
  })

  it('falls back to appWindow.close() when minimize-to-tray is disabled', () => {
    const closeBody = extractFunctionBody(source, 'async function close()')
    expect(closeBody).toBeTruthy()
    expect(closeBody).toContain('appWindow.close()')
  })

  it('passes { visible: false } to set_dock_visible', () => {
    const closeBody = extractFunctionBody(source, 'async function close()')
    expect(closeBody).toBeTruthy()
    expect(closeBody).toContain('{ visible: false }')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 2: MainLayout.vue — onCloseRequested + exit dialog paths
// ═══════════════════════════════════════════════════════════════════

describe('MainLayout.vue — Dock hide on window close paths', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(SRC_ROOT, 'src', 'layouts', 'MainLayout.vue'), 'utf-8')
  })

  describe('onCloseRequested direct hide path', () => {
    it('invokes set_dock_visible in the minimizeToTrayOnClose branch', () => {
      // The onCloseRequested handler checks minimizeToTrayOnClose and calls
      // set_dock_visible as a Rust command. Assert this pattern exists.
      const handlerStart = source.indexOf('onCloseRequested(async')
      expect(handlerStart).toBeGreaterThanOrEqual(0)
      const handlerBody = extractFunctionBody(source, 'onCloseRequested(async')
      expect(handlerBody).toBeTruthy()
      expect(handlerBody).toContain("invoke('set_dock_visible'")
    })

    it('calls set_dock_visible BEFORE appWindow.hide() in direct path', () => {
      const handlerBody = extractFunctionBody(source, 'onCloseRequested(async')!
      // Within the minimizeToTrayOnClose branch, set_dock_visible must precede hide
      const branchStart = handlerBody.indexOf('minimizeToTrayOnClose')
      const branchSlice = handlerBody.slice(branchStart)
      assertOrderedBefore(branchSlice, "invoke('set_dock_visible'", 'appWindow.hide()', 'onCloseRequested direct path')
    })
  })

  describe('onExitDialogAfterLeave path', () => {
    it('invokes set_dock_visible in exit dialog after-leave handler', () => {
      const fnBody = extractFunctionBody(source, 'async function onExitDialogAfterLeave()')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain("invoke('set_dock_visible'")
    })

    it('calls set_dock_visible BEFORE appWindow.hide()', () => {
      const fnBody = extractFunctionBody(source, 'async function onExitDialogAfterLeave()')!
      assertOrderedBefore(fnBody, "invoke('set_dock_visible'", 'appWindow.hide()', 'onExitDialogAfterLeave')
    })
  })

  describe('exit dialog rememberChoice synchronization', () => {
    it('syncs rememberChoice from minimizeToTrayOnClose when dialog opens via onCloseRequested', () => {
      const handlerBody = extractFunctionBody(source, 'onCloseRequested(async')!
      // The dialog path (non-minimize) should set rememberChoice before showing dialog
      expect(handlerBody).toContain('rememberChoice.value = !!preferenceStore.config.minimizeToTrayOnClose')
    })

    it('syncs rememberChoice from minimizeToTrayOnClose when dialog opens via tray quit', () => {
      // The tray-menu-action 'quit' handler also opens the exit dialog
      const quitIdx = source.indexOf("case 'quit':")
      expect(quitIdx).toBeGreaterThanOrEqual(0)
      const quitBlock = source.slice(quitIdx, source.indexOf('break', quitIdx) + 10)
      expect(quitBlock).toContain('rememberChoice.value = !!preferenceStore.config.minimizeToTrayOnClose')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 3: commands/app.rs — Rust set_dock_visible command
// ═══════════════════════════════════════════════════════════════════

describe('commands/app.rs — set_dock_visible Rust command', () => {
  let source: string
  let fnBody: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'commands', 'app.rs'), 'utf-8')
    fnBody = extractFunctionBody(source, 'pub fn set_dock_visible')!
  })

  it('is a #[tauri::command]', () => {
    const fnIdx = source.indexOf('pub fn set_dock_visible')
    const preceding = source.slice(Math.max(0, fnIdx - 100), fnIdx)
    expect(preceding).toContain('#[tauri::command]')
  })

  it('accepts (app: AppHandle, visible: bool) parameters', () => {
    expect(source).toContain('pub fn set_dock_visible(app: AppHandle, visible: bool)')
  })

  it('wraps macOS logic in #[cfg(target_os = "macos")]', () => {
    expect(fnBody).toContain('#[cfg(target_os = "macos")]')
  })

  it('has a #[cfg(not(target_os = "macos"))] no-op branch', () => {
    expect(fnBody).toContain('#[cfg(not(target_os = "macos"))]')
  })

  it('reads hideDockOnMinimize from the persistent store when hiding', () => {
    // When visible=false, must read the preference from store, not from JS
    expect(fnBody).toContain('.store("config.json")')
    expect(fnBody).toContain('"hideDockOnMinimize"')
  })

  it('sets ActivationPolicy::Regular when visible=true', () => {
    expect(fnBody).toContain('ActivationPolicy::Regular')
  })

  it('sets ActivationPolicy::Accessory when hiding and preference is true', () => {
    expect(fnBody).toContain('ActivationPolicy::Accessory')
  })

  it('does NOT unconditionally set Accessory — checks hide_dock first', () => {
    // The Accessory policy must be behind an `if hide_dock` guard
    const accessoryIdx = fnBody.indexOf('ActivationPolicy::Accessory')
    const beforeAccessory = fnBody.slice(0, accessoryIdx)
    expect(beforeAccessory).toContain('if hide_dock')
  })

  it('uses StoreExt for store access', () => {
    expect(fnBody).toContain('StoreExt')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 4: lib.rs — CloseRequested fallback + Reopen restore
// ═══════════════════════════════════════════════════════════════════

describe('lib.rs — CloseRequested Dock hide fallback', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
  })

  describe('CloseRequested handler', () => {
    it('reads minimizeToTrayOnClose from the store', () => {
      const crBlock = source.slice(source.indexOf('CloseRequested'))
      expect(crBlock).toContain('"minimizeToTrayOnClose"')
    })

    it('reads hideDockOnMinimize from the store', () => {
      const crBlock = source.slice(source.indexOf('CloseRequested'))
      expect(crBlock).toContain('"hideDockOnMinimize"')
    })

    it('reads both preferences from a single store access (no redundant reads)', () => {
      // store_prefs is read once and reused for both preference checks
      const crStart = source.indexOf('CloseRequested')
      // Extract until the Reopen handler (next major match arm)
      const reopenIdx = source.indexOf('RunEvent::Reopen')
      const crBlock = source.slice(crStart, reopenIdx)
      // Count occurrences of .store("config.json") — should be exactly 1
      const storeReads = crBlock.split('.store("config.json")').length - 1
      expect(storeReads).toBe(1)
    })

    it('wraps set_activation_policy(Accessory) in cfg(target_os = "macos")', () => {
      const crStart = source.indexOf('CloseRequested')
      const reopenIdx = source.indexOf('RunEvent::Reopen')
      const crBlock = source.slice(crStart, reopenIdx)
      expect(crBlock).toContain('#[cfg(target_os = "macos")]')
      expect(crBlock).toContain('ActivationPolicy::Accessory')
    })

    it('calls api.prevent_close() when should_hide is true', () => {
      const crBlock = source.slice(source.indexOf('CloseRequested'))
      expect(crBlock).toContain('api.prevent_close()')
    })
  })

  describe('Reopen handler — Dock icon restore', () => {
    it('handles RunEvent::Reopen on macOS', () => {
      expect(source).toContain('tauri::RunEvent::Reopen')
    })

    it('restores ActivationPolicy::Regular on Reopen', () => {
      const reopenIdx = source.indexOf('RunEvent::Reopen')
      expect(reopenIdx).toBeGreaterThanOrEqual(0)
      const reopenBlock = source.slice(reopenIdx, source.indexOf('}', reopenIdx + 200))
      expect(reopenBlock).toContain('ActivationPolicy::Regular')
    })

    it('shows and focuses the main window on Reopen', () => {
      const reopenIdx = source.indexOf('RunEvent::Reopen')
      const reopenBlock = source.slice(reopenIdx, source.indexOf('}', reopenIdx + 200))
      expect(reopenBlock).toContain('window.show()')
      expect(reopenBlock).toContain('window.set_focus()')
    })

    it('Reopen handler is gated to macOS only', () => {
      const reopenIdx = source.indexOf('RunEvent::Reopen')
      const preceding = source.slice(Math.max(0, reopenIdx - 100), reopenIdx)
      expect(preceding).toContain('#[cfg(target_os = "macos")]')
    })
  })
})
