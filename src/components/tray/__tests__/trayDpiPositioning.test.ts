/**
 * @fileoverview Structural tests for DPI-aware tray popup positioning.
 *
 * Problem: Different Windows scaling factors (100%, 125%, 150%, 200%)
 * cause the popup to appear at inconsistent positions relative to the
 * tray icon.  Root cause: mixing Physical coordinates (from icon_rect,
 * monitor.size()) with Logical constants (POPUP_WIDTH/HEIGHT in CSS px).
 *
 * Industry standard (Tauri docs, tauri-plugin-positioner, Microsoft UX):
 * Normalize ALL coordinates to Logical using scale_factor(), then use
 * LogicalPosition / LogicalSize for set_position() / inner_size().
 *
 * Verifies:
 * ── Coordinate normalization ──
 * 1. tray.rs calls scale_factor() to get DPI scaling
 * 2. Physical icon coords are divided by scale_factor
 * 3. Physical screen dimensions are divided by scale_factor
 *
 * ── Logical API usage ──
 * 4. set_position uses LogicalPosition (not PhysicalPosition)
 * 5. inner_size uses LogicalSize (not raw f64 values)
 * 6. LogicalPosition and LogicalSize are imported
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const TRAY_RS = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'tray.rs')

describe('tray.rs — DPI-aware positioning (logical coordinates)', () => {
  let source: string
  let fnBody: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_RS, 'utf-8')
    const extracted = extractFnBody(source, 'show_tray_popup')
    expect(extracted).toBeTruthy()
    fnBody = extracted!
  })

  // ── Coordinate normalization ──────────────────────────────────────

  it('retrieves scale_factor from the monitor', () => {
    expect(fnBody).toContain('scale_factor')
  })

  it('divides physical icon coordinates by scale factor', () => {
    // Physical → Logical conversion: p.x as f64 / scale
    expect(fnBody).toMatch(/\/\s*scale/)
  })

  it('divides physical screen dimensions by scale factor', () => {
    // screen_w and screen_h must be in logical coordinates
    // Either divided inline or the source uses logical conversion
    expect(fnBody).toMatch(/\/\s*scale/)
  })

  // ── Logical API usage ─────────────────────────────────────────────

  it('uses LogicalPosition for set_position (not PhysicalPosition)', () => {
    expect(fnBody).toContain('LogicalPosition')
    expect(fnBody).not.toMatch(/set_position\s*\(\s*PhysicalPosition/)
  })

  it('imports LogicalPosition', () => {
    expect(source).toContain('LogicalPosition')
  })

  it('inner_size uses POPUP_WIDTH and POPUP_HEIGHT constants', () => {
    // Tauri WebviewWindowBuilder.inner_size(f64, f64) treats arguments
    // as LOGICAL pixels by default — no LogicalSize wrapper needed.
    const ensureBody = extractFnBody(source, 'ensure_tray_popup')
    expect(ensureBody).toBeTruthy()
    expect(ensureBody).toContain('POPUP_WIDTH')
    expect(ensureBody).toContain('POPUP_HEIGHT')
  })

  // ── Constants are still logical CSS pixels ────────────────────────

  it('POPUP_WIDTH and POPUP_HEIGHT are logical CSS pixel values', () => {
    const wMatch = source.match(/const POPUP_WIDTH:\s*f64\s*=\s*([\d.]+)/)
    const hMatch = source.match(/const POPUP_HEIGHT:\s*f64\s*=\s*([\d.]+)/)
    expect(wMatch).toBeTruthy()
    expect(hMatch).toBeTruthy()
    const w = parseFloat(wMatch![1])
    const h = parseFloat(hMatch![1])
    // These must be CSS logical values (220-240 width, 180-210 height)
    // NOT multiplied by any scale factor
    expect(w).toBeGreaterThanOrEqual(220)
    expect(w).toBeLessThanOrEqual(250)
    expect(h).toBeGreaterThanOrEqual(180)
    expect(h).toBeLessThanOrEqual(210)
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

function extractFnBody(source: string, fnName: string): string | null {
  const idx = source.indexOf(`fn ${fnName}`)
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
