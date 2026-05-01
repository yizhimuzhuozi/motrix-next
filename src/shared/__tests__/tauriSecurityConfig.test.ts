import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const TAURI_CONFIG_PATH = resolve(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json')
const DEFAULT_CAPABILITY_PATH = resolve(PROJECT_ROOT, 'src-tauri', 'capabilities', 'default.json')

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown
}

describe('tauri security config', () => {
  it('enables a production CSP instead of disabling it with null', () => {
    const config = readJson(TAURI_CONFIG_PATH) as {
      app?: { security?: { csp?: unknown } }
    }

    expect(typeof config.app?.security?.csp).toBe('string')
    expect(config.app?.security?.csp).not.toBe('')
  })

  it('does not grant frontend shell execute permission', () => {
    const capability = readJson(DEFAULT_CAPABILITY_PATH) as { permissions?: unknown[] }

    expect(capability.permissions).not.toContain('shell:allow-execute')
  })

  it('does not grant wildcard filesystem or opener scopes', () => {
    const capability = readJson(DEFAULT_CAPABILITY_PATH) as {
      permissions?: Array<string | { allow?: Array<{ path?: string }> }>
    }
    const scopedPaths = capability.permissions
      ?.flatMap((permission) =>
        typeof permission === 'string' ? [] : (permission.allow ?? []).map((entry) => entry.path),
      )
      .filter((path): path is string => typeof path === 'string')

    expect(scopedPaths).not.toContain('**')
  })
})
