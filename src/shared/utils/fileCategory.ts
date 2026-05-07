/**
 * @fileoverview Smart file classification engine — pure functions.
 *
 * Routes downloads to directories based on file extension matching.
 *
 * Two classification strategies:
 *   1. **Pre-Download (instant)**: Resolves `dir` BEFORE the aria2 RPC call
 *      using the URL's extension. aria2 writes directly to the target
 *      directory — zero post-download I/O.
 *   2. **Post-Download (auto-archive)**: For URLs without detectable extensions,
 *      the file downloads to the default directory. After completion,
 *      `resolveArchiveAction` in autoArchive.ts uses the real filename
 *      (from aria2's Content-Disposition resolution) to determine if the
 *      file should be moved.
 *
 * aria2 auto-creates non-existent directories via `util::mkdirs()`
 * (see AbstractDiskWriter.cc:251), so no pre-creation is needed.
 */
import type { FileCategory } from '@shared/types'

/**
 * Extracts the lowercase file extension from a URL or bare filename.
 *
 * Handles:
 * - Standard HTTP/HTTPS/FTP URLs with path segments
 * - Query strings (`?token=...`) and fragments (`#page=3`)
 * - Percent-encoded filenames (`%E6%96%87%E4%BB%B6.pdf`)
 * - Bare filenames without protocol (`document.xlsx`)
 * - Double extensions (`archive.tar.gz` → `gz`)
 *
 * Returns empty string when no extension can be determined:
 * - Magnet URIs, data URIs, blob URIs
 * - URLs without a file path segment
 * - Dotfiles without extension (`.gitignore`)
 */
export function extractExtension(urlOrFilename: string): string {
  if (!urlOrFilename) return ''

  // Skip non-HTTP protocols that don't carry file extensions
  if (/^(magnet|data|blob):/i.test(urlOrFilename)) return ''

  // Extract pathname — strip query string and fragment first
  let pathname: string
  try {
    pathname = new URL(urlOrFilename).pathname
  } catch {
    // Not a valid URL — treat as bare filename or path
    pathname = urlOrFilename.split('?')[0].split('#')[0]
  }

  // Get the last path segment
  const segments = pathname.split('/').filter(Boolean)
  const filename = segments.pop()
  if (!filename) return ''

  // Percent-decode the segment
  let decoded: string
  try {
    decoded = decodeURIComponent(filename)
  } catch {
    decoded = filename
  }

  // Extract extension: last dot that isn't the first character (skip dotfiles)
  const dotIndex = decoded.lastIndexOf('.')
  if (dotIndex <= 0) return ''

  return decoded.substring(dotIndex + 1).toLowerCase()
}

/**
 * Matches a file extension against category rules.
 * Returns the first matching FileCategory, or undefined if none match.
 *
 * First-match wins: rule order defines priority.
 */
export function resolveCategory(ext: string, categories: FileCategory[]): FileCategory | undefined {
  if (!ext) return undefined
  return categories.find((cat) => cat.extensions.includes(ext))
}

/**
 * Resolves the effective download directory for a URI.
 *
 * When classification is enabled and the URI's extension matches a rule,
 * returns the category's absolute directory path.
 * Otherwise returns baseDir unchanged.
 *
 * @param url        - Download URI or filename
 * @param baseDir    - User's configured default download directory
 * @param enabled    - Whether file classification is enabled
 * @param categories - Classification rules with absolute directory paths
 * @returns Resolved absolute directory path
 */
export function resolveDownloadDir(url: string, baseDir: string, enabled: boolean, categories: FileCategory[]): string {
  if (!enabled) return baseDir

  const ext = extractExtension(url)
  const cat = resolveCategory(ext, categories)
  return cat?.directory || baseDir
}
