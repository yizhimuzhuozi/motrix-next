/**
 * @fileoverview Structural regression tests for deep-link startup handling.
 *
 * Lightweight mode destroys and recreates the WebView. The Tauri deep-link
 * plugin's getCurrent() value is process-level state, not a one-shot queue, so
 * frontend startup must not consume it on every WebView bootstrap.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC_ROOT = path.resolve(__dirname, '..', '..')
const MAIN_TS = path.join(SRC_ROOT, 'main.ts')

describe('main.ts — deep-link startup ownership', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(MAIN_TS, 'utf-8')
  })

  it('does not read tauri-plugin-deep-link getCurrent from WebView startup', () => {
    const executableSource = stripComments(source)
    expect(executableSource).not.toContain('@tauri-apps/plugin-deep-link')
    expect(executableSource).not.toContain('getCurrent()')
  })

  it('documents that external input is drained through useAppEvents', () => {
    expect(source).toContain('External input routing is owned by Rust')
    expect(source).toContain('take_pending_deep_links')
  })
})

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}
