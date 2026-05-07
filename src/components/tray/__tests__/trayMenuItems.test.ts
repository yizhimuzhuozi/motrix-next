/**
 * @fileoverview Structural tests for native tray menu item definitions.
 *
 * Verifies that tray.rs defines all required native MenuItem entries
 * using Tauri's Menu API (not a custom WebviewWindow popup).
 *
 * Architecture: All three platforms (macOS, Windows, Linux) use native
 * OS-rendered menus attached to the tray icon via TrayIconBuilder::menu().
 * Menu items are defined via MenuItem::with_id() in Rust, and their
 * labels are dynamically updated via the update_tray_menu_labels command.
 *
 * HONESTY NOTE: These tests read REAL source files — no mocks.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const TRAY_RS = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'tray.rs')

describe('tray.rs — native Menu item definitions', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_RS, 'utf-8')
  })

  it('defines all 5 required MenuItem entries with correct IDs', () => {
    const requiredIds = ['show', 'tray-new-task', 'tray-resume-all', 'tray-pause-all', 'tray-quit']
    for (const id of requiredIds) {
      expect(source, `MenuItem with id "${id}" must exist`).toContain(`"${id}"`)
    }
  })

  it('uses MenuItem::with_id for each menu item (not IconMenuItem or custom)', () => {
    // All items should use standard MenuItem::with_id — native text menu items
    const menuItemMatches = source.match(/MenuItem::with_id\(/g)
    expect(menuItemMatches, 'should have at least 5 MenuItem::with_id calls').toBeTruthy()
    expect(menuItemMatches!.length).toBeGreaterThanOrEqual(5)
  })

  it('creates separators using PredefinedMenuItem::separator', () => {
    const separatorMatches = source.match(/PredefinedMenuItem::separator/g)
    expect(separatorMatches, 'should have at least 2 separators').toBeTruthy()
    expect(separatorMatches!.length).toBeGreaterThanOrEqual(2)
  })

  it('builds a Menu::with_items containing all items and separators', () => {
    expect(source).toContain('Menu::with_items')
    // The menu constructor must reference all 5 items
    const menuBlock = extractMenuWithItems(source)
    expect(menuBlock, 'Menu::with_items block must exist').toBeTruthy()
    expect(menuBlock).toContain('show_item')
    expect(menuBlock).toContain('new_task_item')
    expect(menuBlock).toContain('resume_all_item')
    expect(menuBlock).toContain('pause_all_item')
    expect(menuBlock).toContain('quit_item')
  })

  it('quit item is the last item before the closing bracket', () => {
    const menuBlock = extractMenuWithItems(source)
    expect(menuBlock).toBeTruthy()
    // quit_item should appear after pause_all_item
    const pauseIdx = menuBlock!.indexOf('pause_all_item')
    const quitIdx = menuBlock!.indexOf('quit_item')
    expect(quitIdx).toBeGreaterThan(pauseIdx)
  })
})

describe('tray.rs — native menu attached to TrayIconBuilder', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_RS, 'utf-8')
  })

  it('attaches menu to TrayIconBuilder via .menu()', () => {
    // The native menu must be bound to the tray icon builder
    expect(source).toContain('.menu(')
    // Must reference the menu variable
    expect(source).toMatch(/\.menu\(&menu\)/)
  })

  it('marks the macOS tray icon as a template image', () => {
    // macOS menu bar icons must be template images so AppKit can adapt
    // their rendered color to light, dark, and highlighted menu bar states.
    expect(source).toContain('icon_as_template')
    expect(source).toContain('TRAY_ICON_IS_TEMPLATE')
    expect(source).toMatch(/TRAY_ICON_IS_TEMPLATE:\s*bool\s*=\s*cfg!\(target_os\s*=\s*"macos"\)/)
    expect(source).toMatch(/\.icon_as_template\(TRAY_ICON_IS_TEMPLATE\)/)
  })

  it('keeps template rendering when the tray icon is refreshed', () => {
    const refreshBody = extractBody(source, 'pub fn refresh_tray_icon')
    expect(refreshBody).toBeTruthy()
    expect(refreshBody).toContain('tray.set_icon(Some(icon))')
    expect(refreshBody).toContain('TRAY_ICON_IS_TEMPLATE')
    expect(refreshBody).toContain('tray.set_icon_as_template(true)')
  })

  it('disables menu on left click for macOS (menu_on_left_click)', () => {
    // macOS: .menu() defaults to showing menu on both left and right click.
    // Must explicitly disable left-click menu to preserve left-click = show window.
    expect(source).toContain('show_menu_on_left_click(false)')
  })

  it('does NOT use WebviewWindowBuilder for a tray popup window', () => {
    // WebviewWindowBuilder IS used for get_or_create_main_window (Wayland
    // force-close recovery), but the tray popup approach is removed.
    expect(source).not.toContain('ensure_tray_popup')
    expect(source).not.toContain('show_tray_popup')
    expect(source).not.toContain('POPUP_WIDTH')
    expect(source).not.toContain('POPUP_HEIGHT')
  })

  it('does NOT have cfg(not(target_os = "linux")) for menu creation', () => {
    // Menu creation must be unified across all 3 platforms — no platform gate
    // The only cfg gates should be for ActivationPolicy (macOS-only)
    expect(source).not.toMatch(/#\[cfg\(not\(target_os\s*=\s*"linux"\)\)\]\s*fn\s+ensure_tray_popup/)
    expect(source).not.toMatch(/#\[cfg\(not\(target_os\s*=\s*"linux"\)\)\]\s*fn\s+show_tray_popup/)
    expect(source).not.toMatch(/#\[cfg\(not\(target_os\s*=\s*"linux"\)\)\]\s*const\s+POPUP/)
  })
})

describe('tray.rs — on_menu_event unified handler', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_RS, 'utf-8')
  })

  it('handles "show" menu event through shared window activation', () => {
    const menuEventBlock = extractOnMenuEvent(source)
    expect(menuEventBlock).toBeTruthy()
    expect(menuEventBlock).toContain('"show"')
    expect(menuEventBlock).toContain('activate_main_window')
  })

  it('shared window activation restores ActivationPolicy on macOS', () => {
    const activationBody = extractBody(source, 'pub fn activate_main_window')
    expect(activationBody).toBeTruthy()
    expect(activationBody).toContain('ActivationPolicy::Regular')
  })

  it('dispatches pause/resume through resolve_tray_action', () => {
    // After the lightweight mode fix, only pause/resume go through
    // resolve_tray_action. quit and new-task are handled natively.
    const menuEventBlock = extractOnMenuEvent(source)
    expect(menuEventBlock).toBeTruthy()
    expect(menuEventBlock).toContain('resolve_tray_action')
    expect(menuEventBlock).toContain('tray-menu-action')
  })

  it('handles tray-quit natively via app.exit() (not resolve_tray_action)', () => {
    // In lightweight mode, the WebView is destroyed — emit to frontend
    // silently fails. Quit MUST be handled in Rust via app.exit(0)
    // to ensure the app can always exit. See issue #194.
    const menuEventBlock = extractOnMenuEvent(source)
    expect(menuEventBlock).toBeTruthy()
    expect(menuEventBlock).toContain('"tray-quit"')
    expect(menuEventBlock).toContain('app.exit(')
  })

  it('on_menu_event is NOT cfg-gated to Linux only', () => {
    // The event handler must exist for all platforms, not just Linux
    expect(source).not.toMatch(/#\[cfg\(target_os\s*=\s*"linux"\)\]\s*let\s+builder\s*=\s*builder\.menu/)
  })
})

describe('tray.rs — left-click shows main window', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_RS, 'utf-8')
  })

  it('handles left-click to show and focus main window', () => {
    expect(source).toContain('MouseButton::Left')
    expect(source).toContain('window.show()')
    expect(source).toContain('window.set_focus()')
  })

  it('sets ActivationPolicy::Regular on macOS left-click', () => {
    // Must restore dock icon before showing window
    expect(source).toContain('ActivationPolicy::Regular')
  })

  it('does NOT handle right-click to show a custom popup', () => {
    // Right-click should trigger the native menu (automatic with .menu())
    // No explicit MouseButton::Right handler for popup
    expect(source).not.toContain('show_tray_popup')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the Menu::with_items(...) constructor block.
 */
function extractMenuWithItems(source: string): string | null {
  const marker = 'Menu::with_items'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const start = source.indexOf('(', idx)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '(') depth++
    if (source[i] === ')') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}

/**
 * Extract the .on_menu_event(...) handler block.
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

function extractBody(source: string, marker: string): string | null {
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
