/** @fileoverview Tests for Motrix internal deep-link parsing. */
import { describe, expect, it } from 'vitest'
import { isMotrixNewTaskLink, parseMotrixDeepLink } from '../motrixDeepLink'

describe('motrixDeepLink', () => {
  it('parses the canonical extension new-task deep link', () => {
    const link =
      'motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip&referer=https%3A%2F%2Fexample.com&cookie=session%3Dabc&filename=file.zip'

    const parsed = parseMotrixDeepLink(link)

    expect(parsed.valid).toBe(true)
    expect(parsed.action).toBe('new')
    expect(parsed.isNewTask).toBe(true)
    expect(parsed.downloadUrl).toBe('https://example.com/file.zip')
    expect(parsed.referer).toBe('https://example.com')
    expect(parsed.cookie).toBe('session=abc')
    expect(parsed.filename).toBe('file.zip')
  })

  it('parses single-slash new-task deep links through the same path', () => {
    const link = 'motrixnext:/new?url=https%3A%2F%2Fexample.com%2Ffile.zip'

    const parsed = parseMotrixDeepLink(link)

    expect(parsed.valid).toBe(true)
    expect(parsed.action).toBe('new')
    expect(parsed.isNewTask).toBe(true)
    expect(parsed.downloadUrl).toBe('https://example.com/file.zip')
    expect(isMotrixNewTaskLink(link)).toBe(true)
  })

  it('treats motrixnext wake links without a download URL as wake-only', () => {
    const parsed = parseMotrixDeepLink('motrixnext://')

    expect(parsed.valid).toBe(true)
    expect(parsed.action).toBe('none')
    expect(parsed.isNewTask).toBe(false)
    expect(parsed.downloadUrl).toBe('')
  })

  it('rejects non-Motrix URLs', () => {
    const parsed = parseMotrixDeepLink('https://example.com/file.zip')

    expect(parsed.valid).toBe(false)
    expect(parsed.reason).toBe('unsupported-scheme')
    expect(isMotrixNewTaskLink('https://example.com/file.zip')).toBe(false)
  })
})
