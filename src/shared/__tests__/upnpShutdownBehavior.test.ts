import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const LIB_SOURCE = readFileSync(resolve(__dirname, '../../../src-tauri/src/lib.rs'), 'utf-8')

describe('UPnP shutdown behavior', () => {
  it('wraps stop_mapping in a timeout on app exit', () => {
    const exitIdx = LIB_SOURCE.indexOf('tauri::RunEvent::Exit =>')
    expect(exitIdx).toBeGreaterThanOrEqual(0)
    const snippet = LIB_SOURCE.slice(exitIdx, exitIdx + 3200)
    expect(snippet).toContain('timeout(')
    expect(snippet).toContain('upnp::stop_mapping')
  })
})
