/** @fileoverview Tests for resource detection utilities. */
import { describe, it, expect } from 'vitest'
import { decodeThunderLink, splitTaskLinks, detectResource, needCheckCopyright } from '../resource'
import { DETECT_RESOURCE_MAX_CHARS, DETECT_RESOURCE_MAX_LINES } from '@shared/constants'
import type { ClipboardConfig } from '@shared/types'

describe('decodeThunderLink', () => {
  it('returns non-thunder links unchanged', () => {
    expect(decodeThunderLink('http://example.com/file.zip')).toBe('http://example.com/file.zip')
  })
  it('decodes thunder:// encoded link', () => {
    const encoded = 'thunder://' + btoa('AAhttp://example.com/file.zipZZ')
    const result = decodeThunderLink(encoded)
    expect(result).toBe('http://example.com/file.zip')
  })
  it('returns malformed thunder:// links unchanged instead of throwing', () => {
    expect(() => decodeThunderLink('thunder://not valid base64')).not.toThrow()
    expect(decodeThunderLink('thunder://not valid base64')).toBe('thunder://not valid base64')
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
  it('keeps processing later links after a malformed thunder link', () => {
    const thunderLink = 'thunder://' + btoa('AAhttp://decoded.com/file.zipZZ')
    const result = splitTaskLinks(`thunder://not valid base64\n${thunderLink}\nhttp://normal.com/file.zip`)
    expect(result).toEqual(['thunder://not valid base64', 'http://decoded.com/file.zip', 'http://normal.com/file.zip'])
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// detectResource — comprehensive TDD test suite
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('detectResource', () => {
  // ── Valid single-line resources (should trigger) ────────────────────

  describe('valid single-line resources', () => {
    it('detects http:// URL', () => {
      expect(detectResource('http://example.com/file.zip')).toBe(true)
    })

    it('detects https:// URL', () => {
      expect(detectResource('https://cdn.example.com/release-v2.tar.gz')).toBe(true)
    })

    it('detects ftp:// URL', () => {
      expect(detectResource('ftp://mirror.example.com/pub/file.iso')).toBe(true)
    })

    it('detects magnet link', () => {
      expect(detectResource('magnet:?xt=urn:btih:abc123def456')).toBe(true)
    })

    it('detects thunder:// link', () => {
      expect(detectResource('thunder://QUFodHRwOi8vZXhhbXBsZS5jb20vZmlsZS56aXBaWg==')).toBe(true)
    })

    it('detects URL with trailing whitespace', () => {
      expect(detectResource('  https://example.com/file.zip  ')).toBe(true)
    })

    it('detects uppercase HTTP:// URL', () => {
      expect(detectResource('HTTP://EXAMPLE.COM/file.zip')).toBe(true)
    })

    it('detects mixed-case Https:// URL', () => {
      expect(detectResource('Https://cdn.example.com/release.tar.gz')).toBe(true)
    })

    it('detects uppercase FTP:// URL', () => {
      expect(detectResource('FTP://mirror.example.com/pub/file.iso')).toBe(true)
    })
  })

  // ── Valid multi-line resource lists (should trigger) ────────────────

  describe('valid multi-line resource lists', () => {
    it('detects multiple http URLs on separate lines', () => {
      expect(detectResource('http://a.com/1.zip\nhttps://b.com/2.zip')).toBe(true)
    })

    it('detects mixed protocols on separate lines', () => {
      const input = 'http://a.com/file.zip\nftp://b.com/file.iso\nmagnet:?xt=urn:btih:abc'
      expect(detectResource(input)).toBe(true)
    })

    it('detects URLs with blank lines between them', () => {
      expect(detectResource('http://a.com\n\nhttps://b.com\n\n')).toBe(true)
    })

    it('detects URLs with Windows-style line endings', () => {
      expect(detectResource('http://a.com\r\nhttps://b.com')).toBe(true)
    })
  })

  // ── False positives that MUST be rejected ──────────────────────────

  describe('false positives — embedded URLs in text', () => {
    it('rejects paragraph containing a URL', () => {
      expect(detectResource('Visit http://example.com for more info')).toBe(false)
    })

    it('rejects code comment containing URL', () => {
      expect(detectResource('// fetch from https://api.example.com/data')).toBe(false)
    })

    it('rejects markdown with URL', () => {
      expect(detectResource('[click here](https://example.com)')).toBe(false)
    })

    it('rejects log line containing URL', () => {
      expect(detectResource('[INFO] Downloaded from http://cdn.example.com/v2.zip successfully')).toBe(false)
    })

    it('rejects HTML anchor tag', () => {
      expect(detectResource('<a href="https://example.com">link</a>')).toBe(false)
    })
  })

  describe('false positives — mixed content', () => {
    it('rejects multi-line text where only some lines are URLs', () => {
      expect(detectResource('Here is a file:\nhttp://example.com/file.zip')).toBe(false)
    })

    it('rejects URL followed by description text', () => {
      expect(detectResource('http://example.com\nThis is my download server')).toBe(false)
    })

    it('rejects JSON containing a URL field', () => {
      const json = '{"url": "https://example.com/api/data"}'
      expect(detectResource(json)).toBe(false)
    })
  })

  // ── Size and line limits ──────────────────────────────────────────

  describe('size and line limits', () => {
    it('detects 50 HTTP URLs that collectively exceed 2048 characters (#125 regression)', () => {
      // 50 URLs × ~60 chars each ≈ 3000 chars — well over old 2048 limit
      const urls = Array.from({ length: 50 }, (_, i) => `https://cdn.example.com/files/package-${i}-release.zip`)
      const content = urls.join('\n')
      expect(content.length).toBeGreaterThan(2048)
      expect(detectResource(content)).toBe(true)
    })

    it('accepts exactly DETECT_RESOURCE_MAX_LINES lines of valid URLs', () => {
      const urls = Array.from(
        { length: DETECT_RESOURCE_MAX_LINES },
        (_, i) => `https://mirror${i}.example.com/file.zip`,
      )
      expect(detectResource(urls.join('\n'))).toBe(true)
    })

    it('rejects DETECT_RESOURCE_MAX_LINES + 1 lines', () => {
      const urls = Array.from(
        { length: DETECT_RESOURCE_MAX_LINES + 1 },
        (_, i) => `https://mirror${i}.example.com/file.zip`,
      )
      expect(detectResource(urls.join('\n'))).toBe(false)
    })

    it('rejects content exceeding DETECT_RESOURCE_MAX_CHARS', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(DETECT_RESOURCE_MAX_CHARS + 1)
      expect(detectResource(longUrl)).toBe(false)
    })

    it('accepts content just under DETECT_RESOURCE_MAX_CHARS with valid URLs', () => {
      // Build valid URLs that stay under the char limit
      const url = 'https://cdn.example.com/f.zip'
      const count = Math.min(Math.floor(DETECT_RESOURCE_MAX_CHARS / (url.length + 1)) - 1, DETECT_RESOURCE_MAX_LINES)
      const content = Array.from({ length: count }, () => url).join('\n')
      expect(content.length).toBeLessThan(DETECT_RESOURCE_MAX_CHARS)
      expect(detectResource(content)).toBe(true)
    })

    it('still rejects a single-line non-URL text', () => {
      const longText = 'a'.repeat(5000)
      expect(detectResource(longText)).toBe(false)
    })
  })

  // ── Bare BitTorrent info hashes ────────────────────────────────────

  describe('bare info hash detection', () => {
    it('detects a bare SHA-1 hex hash (40 chars)', () => {
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6e')).toBe(true)
    })

    it('detects an uppercase SHA-1 hex hash (40 chars)', () => {
      expect(detectResource('D8988E034CB5DE79D319242E3365BF30A7741A6E')).toBe(true)
    })

    it('detects a bare Base32 hash (32 chars)', () => {
      expect(detectResource('TCIY4A2MWXPHTUYZEQUOMNS7GCDXOQTG')).toBe(true)
    })

    it('detects mixed bare hash and magnet URI on separate lines', () => {
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6e\nmagnet:?xt=urn:btih:abc')).toBe(true)
    })

    it('rejects 39-char hex (too short)', () => {
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6')).toBe(false)
    })

    it('rejects 41-char hex (too long)', () => {
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6ef')).toBe(false)
    })

    it('rejects 64-char hex (SHA-256/BT v2 — unsupported by aria2)', () => {
      expect(detectResource('aabbccddee00112233445566778899aabbccddee00112233445566778899aabb')).toBe(false)
    })

    it('rejects 32-char lowercase string (not valid Base32)', () => {
      expect(detectResource('abcdefghijklmnopqrstuvwxyz234567')).toBe(false)
    })
  })

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns false for empty string', () => {
      expect(detectResource('')).toBe(false)
    })

    it('returns false for plain text', () => {
      expect(detectResource('hello world')).toBe(false)
    })

    it('returns false for whitespace-only string', () => {
      expect(detectResource('   \n\n   ')).toBe(false)
    })

    it('returns false for random protocol-like strings', () => {
      expect(detectResource('myapp://open?id=123')).toBe(false)
    })

    it('returns false for email addresses', () => {
      expect(detectResource('user@http://example.com')).toBe(false)
    })
  })

  // ── Bare protocol rejection ───────────────────────────────────────

  describe('bare protocol rejection', () => {
    it('rejects bare https:// protocol', () => {
      expect(detectResource('https://')).toBe(false)
    })

    it('rejects bare http:// protocol', () => {
      expect(detectResource('http://')).toBe(false)
    })

    it('rejects bare ftp:// protocol', () => {
      expect(detectResource('ftp://')).toBe(false)
    })

    it('rejects bare magnet: protocol', () => {
      expect(detectResource('magnet:')).toBe(false)
    })

    it('rejects bare thunder:// protocol', () => {
      expect(detectResource('thunder://')).toBe(false)
    })

    it('still detects URL with content after protocol', () => {
      expect(detectResource('https://x')).toBe(true)
    })
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// detectResource — ClipboardConfig filter parameter (TDD RED phase)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('detectResource with ClipboardConfig filter', () => {
  /** Factory for a fully-enabled filter (all protocols on). */
  const allEnabled = (): ClipboardConfig => ({
    enable: true,
    http: true,
    ftp: true,
    magnet: true,
    thunder: true,
    btHash: true,
  })

  // ── Backward compatibility ────────────────────────────────────────

  describe('backward compatibility (no filter)', () => {
    it('detects http URL without filter argument', () => {
      expect(detectResource('https://example.com/file.zip')).toBe(true)
    })

    it('detects magnet link without filter argument', () => {
      expect(detectResource('magnet:?xt=urn:btih:abc123')).toBe(true)
    })

    it('rejects plain text without filter argument', () => {
      expect(detectResource('hello world')).toBe(false)
    })
  })

  // ── Total enable switch ───────────────────────────────────────────

  describe('total enable switch', () => {
    it('rejects all content when enable is false', () => {
      const filter: ClipboardConfig = { ...allEnabled(), enable: false }
      expect(detectResource('https://example.com/file.zip', filter)).toBe(false)
    })

    it('rejects magnet link when enable is false', () => {
      const filter: ClipboardConfig = { ...allEnabled(), enable: false }
      expect(detectResource('magnet:?xt=urn:btih:abc123', filter)).toBe(false)
    })

    it('detects http URL when enable is true with all protocols on', () => {
      expect(detectResource('https://example.com/file.zip', allEnabled())).toBe(true)
    })
  })

  // ── Per-protocol toggles ──────────────────────────────────────────

  describe('per-protocol toggles', () => {
    it('rejects http URL when http is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), http: false }
      expect(detectResource('http://example.com/file.zip', filter)).toBe(false)
    })

    it('rejects https URL when http is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), http: false }
      expect(detectResource('https://cdn.example.com/release.tar.gz', filter)).toBe(false)
    })

    it('still detects magnet link when http is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), http: false }
      expect(detectResource('magnet:?xt=urn:btih:abc123def456', filter)).toBe(true)
    })

    it('rejects ftp URL when ftp is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), ftp: false }
      expect(detectResource('ftp://mirror.example.com/pub/file.iso', filter)).toBe(false)
    })

    it('still detects http URL when ftp is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), ftp: false }
      expect(detectResource('https://example.com/file.zip', filter)).toBe(true)
    })

    it('rejects magnet link when magnet is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), magnet: false }
      expect(detectResource('magnet:?xt=urn:btih:abc123def456', filter)).toBe(false)
    })

    it('still detects http URL when magnet is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), magnet: false }
      expect(detectResource('https://example.com/file.zip', filter)).toBe(true)
    })

    it('rejects thunder link when thunder is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), thunder: false }
      expect(detectResource('thunder://QUFodHRwOi8vZXhhbXBsZS5jb20vZmlsZS56aXBaWg==', filter)).toBe(false)
    })

    it('rejects bare SHA-1 info hash when btHash is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), btHash: false }
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6e', filter)).toBe(false)
    })

    it('rejects bare Base32 info hash when btHash is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), btHash: false }
      expect(detectResource('TCIY4A2MWXPHTUYZEQUOMNS7GCDXOQTG', filter)).toBe(false)
    })

    it('still detects magnet link when btHash is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), btHash: false }
      expect(detectResource('magnet:?xt=urn:btih:abc123def456', filter)).toBe(true)
    })
  })

  // ── Multi-line mixed content with partial disables ────────────────

  describe('multi-line content with partial protocol disables', () => {
    it('rejects multi-line when one line uses a disabled protocol', () => {
      const filter: ClipboardConfig = { ...allEnabled(), magnet: false }
      const content = 'https://example.com/file.zip\nmagnet:?xt=urn:btih:abc'
      expect(detectResource(content, filter)).toBe(false)
    })

    it('accepts multi-line when all lines use enabled protocols', () => {
      const filter: ClipboardConfig = { ...allEnabled(), magnet: false }
      const content = 'https://a.com/1.zip\nftp://b.com/2.iso'
      expect(detectResource(content, filter)).toBe(true)
    })

    it('rejects multi-line with hash when btHash is disabled', () => {
      const filter: ClipboardConfig = { ...allEnabled(), btHash: false }
      const content = 'https://example.com/file.zip\nd8988e034cb5de79d319242e3365bf30a7741a6e'
      expect(detectResource(content, filter)).toBe(false)
    })
  })

  // ── All protocols disabled ────────────────────────────────────────

  describe('all protocols disabled', () => {
    it('rejects everything when all protocol toggles are off', () => {
      const filter: ClipboardConfig = {
        enable: true,
        http: false,
        ftp: false,
        magnet: false,
        thunder: false,
        btHash: false,
      }
      expect(detectResource('https://example.com/file.zip', filter)).toBe(false)
      expect(detectResource('ftp://mirror.com/file.iso', filter)).toBe(false)
      expect(detectResource('magnet:?xt=urn:btih:abc', filter)).toBe(false)
      expect(detectResource('thunder://QUFodHRwOi8vZmlsZS56aXBaWg==', filter)).toBe(false)
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6e', filter)).toBe(false)
    })
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
