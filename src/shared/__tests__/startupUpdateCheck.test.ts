/**
 * @fileoverview Structural tests for startup update-check scheduling.
 *
 * The startup checker runs from the frontend bootstrap, including lightweight
 * mode WebView recreation. An interval value of 0 means every startup and must
 * remain a first-class value instead of being collapsed by truthy fallbacks.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = readFileSync(resolve(__dirname, '../../main.ts'), 'utf-8')

function extractFunctionBody(fnName: string): string {
  const start = SOURCE.indexOf(`function ${fnName}`)
  if (start === -1) throw new Error(`${fnName} not found in source`)

  let depth = 0
  let bodyStart = -1
  for (let i = start; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') {
      if (bodyStart === -1) bodyStart = i
      depth++
    } else if (SOURCE[i] === '}') {
      depth--
      if (depth === 0) return SOURCE.slice(bodyStart, i + 1)
    }
  }

  throw new Error(`Could not find closing brace for ${fnName}`)
}

describe('autoCheckForUpdate startup interval handling', () => {
  const body = extractFunctionBody('autoCheckForUpdate')

  it('keeps 0 as the every-startup interval instead of falling back to 24 hours', () => {
    expect(body).not.toContain('config.autoCheckUpdateInterval) || 24')
    expect(body).toContain('config.autoCheckUpdateInterval')
    expect(body).toMatch(/autoCheckUpdateInterval[\s\S]*\?\?/)
  })

  it('only applies last-check throttling to positive intervals', () => {
    expect(body).toContain('intervalHours > 0')
    expect(body).toContain('lastCheckUpdateTime')
  })
})
