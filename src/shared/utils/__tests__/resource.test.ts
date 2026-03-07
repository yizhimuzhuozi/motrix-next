/** @fileoverview Tests for resource detection utilities. */
import { describe, it, expect } from 'vitest'
import { decodeThunderLink, splitTaskLinks, detectResource, needCheckCopyright } from '../resource'

describe('decodeThunderLink', () => {
  it('returns non-thunder links unchanged', () => {
    expect(decodeThunderLink('http://example.com/file.zip')).toBe('http://example.com/file.zip')
  })
  it('decodes thunder:// encoded link', () => {
    const encoded = 'thunder://' + btoa('AAhttp://example.com/file.zipZZ')
    const result = decodeThunderLink(encoded)
    expect(result).toBe('http://example.com/file.zip')
  })
})

describe('splitTaskLinks', () => {
  it('splits multiline links', () => {
    const result = splitTaskLinks('http://a.com\nhttp://b.com')
    expect(result).toEqual(['http://a.com', 'http://b.com'])
  })
  it('returns empty for empty input', () => {
    expect(splitTaskLinks('')).toEqual([])
  })
  it('decodes thunder links within multiline input', () => {
    const thunderLink = 'thunder://' + btoa('AAhttp://decoded.com/file.zipZZ')
    const result = splitTaskLinks(`http://normal.com\n${thunderLink}`)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('http://normal.com')
    expect(result[1]).toBe('http://decoded.com/file.zip')
  })
})

describe('detectResource', () => {
  it('detects http links', () => {
    expect(detectResource('http://example.com')).toBe(true)
  })
  it('detects magnet links', () => {
    expect(detectResource('magnet:?xt=urn:btih:abc')).toBe(true)
  })
  it('detects ftp links', () => {
    expect(detectResource('ftp://mirror.example.com/file.iso')).toBe(true)
  })
  it('detects thunder links', () => {
    expect(detectResource('thunder://QUFodHRwOi8vZXhhbXBsZS5jb20vZmlsZS56aXBaWg==')).toBe(true)
  })
  it('returns false for plain text', () => {
    expect(detectResource('hello world')).toBe(false)
  })
})

describe('needCheckCopyright', () => {
  it('returns true for video links', () => {
    expect(needCheckCopyright('http://example.com/video.mp4')).toBe(true)
  })
  it('returns true for audio links', () => {
    expect(needCheckCopyright('http://example.com/song.mp3')).toBe(true)
  })
  it('returns false for non-media links', () => {
    expect(needCheckCopyright('http://example.com/file.zip')).toBe(false)
  })
  it('returns false for empty string', () => {
    expect(needCheckCopyright('')).toBe(false)
  })
})
