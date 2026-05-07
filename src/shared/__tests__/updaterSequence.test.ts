/**
 * @fileoverview Structural tests for updater.rs apply_update sequence.
 *
 * Ensures check() is called before take() so that a network failure
 * during the second check does not discard already-downloaded bytes.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TAURI_ROOT = path.resolve(__dirname, '../../../src-tauri')

/**
 * Extract the body of a Rust function from its declaration to the next
 * `#[tauri::command]` attribute or end of `#[cfg(test)]` module.
 */
function extractRustFnBody(source: string, fnSignature: string): string {
  const fnIdx = source.indexOf(fnSignature)
  if (fnIdx === -1) return ''
  const body = source.slice(fnIdx)
  // Find the end: next #[tauri::command] or #[cfg(test)] or EOF
  const nextCommand = body.indexOf('#[tauri::command]', fnSignature.length)
  const nextCfgTest = body.indexOf('#[cfg(test)]', fnSignature.length)
  const candidates = [nextCommand, nextCfgTest].filter((i) => i > 0)
  const end = candidates.length > 0 ? Math.min(...candidates) : body.length
  return body.slice(0, end)
}

describe('updater.rs — apply_update sequence', () => {
  let applyUpdateBody: string

  beforeAll(() => {
    const updaterPath = path.join(TAURI_ROOT, 'src', 'commands', 'updater.rs')
    const source = fs.readFileSync(updaterPath, 'utf-8')
    applyUpdateBody = extractRustFnBody(source, 'pub async fn apply_update')
    expect(applyUpdateBody.length).toBeGreaterThan(0)
  })

  it('resolves the remote update before .take() to avoid discarding downloaded bytes', () => {
    const checkIdx = applyUpdateBody.indexOf('resolve_update')
    const takeIdx = applyUpdateBody.indexOf('.take()')
    expect(checkIdx).toBeGreaterThan(0)
    expect(takeIdx).toBeGreaterThan(0)
    expect(checkIdx).toBeLessThan(takeIdx)
  })

  it('calls .take() exactly once (no duplicate consumption)', () => {
    const matches = applyUpdateBody.match(/\.take\(\)/g)
    expect(matches).toHaveLength(1)
  })

  it('handles stop_engine errors instead of discarding the result', () => {
    expect(applyUpdateBody).not.toContain('let _ = crate::engine::stop_engine')
    expect(applyUpdateBody).toContain('crate::engine::stop_engine')
  })

  it('only consumes cached bytes after stop_engine succeeds', () => {
    const stopIdx = applyUpdateBody.indexOf('crate::engine::stop_engine')
    const bytesIdx = applyUpdateBody.indexOf('let bytes =')
    expect(stopIdx).toBeGreaterThan(0)
    expect(bytesIdx).toBeGreaterThan(stopIdx)
  })
})

describe('updater.rs — version-pinned package cache', () => {
  let updaterSource: string
  const updaterPath = path.join(TAURI_ROOT, 'src', 'commands', 'updater.rs')

  beforeAll(() => {
    updaterSource = fs.readFileSync(updaterPath, 'utf-8')
  })

  it('defines DownloadedPackage struct with downloaded_version field', () => {
    expect(updaterSource).toContain('struct DownloadedPackage')
    expect(updaterSource).toMatch(/downloaded_version:\s*String/)
  })

  it('download_update stores version alongside bytes in DownloadedPackage', () => {
    const body = extractRustFnBody(updaterSource, 'pub async fn download_update')
    expect(body).toBeTruthy()
    expect(body).toContain('DownloadedPackage')
    expect(body).toContain('downloaded_version')
  })

  it('apply_update compares cached version against remote version before install', () => {
    const body = extractRustFnBody(updaterSource, 'pub async fn apply_update')
    expect(body).toBeTruthy()
    // Must reference both the cached version and the update version in a comparison
    expect(body).toContain('downloaded_version')
    expect(body).toContain('update.version')
  })

  it('apply_update preserves cache on version mismatch without consuming the package', () => {
    const body = extractRustFnBody(updaterSource, 'pub async fn apply_update')
    expect(body).toBeTruthy()
    expect(body).toContain('.as_ref()')
    expect(body).toContain('Downloaded v{cached_ver}')
  })

  it('download_update exposes a structured result status', () => {
    expect(updaterSource).toContain('DownloadUpdateResult')
    expect(updaterSource).toContain('DownloadUpdateStatus')
    expect(updaterSource).toContain('NoUpdate')
    expect(updaterSource).toContain('Downloaded')
  })

  it('build_updater rejects invalid proxy strings instead of silently ignoring them', () => {
    const body = extractRustFnBody(updaterSource, 'fn build_updater')
    expect(body).toBeTruthy()
    expect(body).toContain('Url::parse')
    expect(body).not.toContain('if let Ok(proxy_url)')
  })
})
